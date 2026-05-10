#!/usr/bin/env node

/**
 * SLOProxy Proxy Server
 *
 * A lightweight authenticated proxy that sits in front of a local inference
 * servers (Ollama, LM Studio, etc.) and can expose them securely via a local
 * endpoint, Tailscale Funnel, or Cloudflare Tunnel.
 *
 *   1. Auto-detects OpenAI-compatible backends and prompts to configure them.
 *   2. Validates a shared API key on tunneled requests.
 *   3. Prefixes exposed models by provider slug and routes by that prefix.
 *   4. Optionally exposes the proxy with Tailscale Funnel or Cloudflare Tunnel.
 *
 * Usage:
 *   node server.mjs [options]
 *   node server.mjs init [options]
 *
 * Options:
 *   --port <n>              Port for this proxy (default: 13531).
 *   --funnel-port <n>       Public HTTPS port for Tailscale Funnel (default: 8443).
 *   --backend <url>         Skip auto-detection and use this backend URL directly.
 *   --provider <slug:port>  Configure a localhost provider; repeatable.
 *   --tunnel <mode>         local, tailscale, or cloudflare (default: local).
 *   --api-key <key>         Shared secret for tunneled proxy authentication.
 *   --no-tunnel             Alias for --tunnel local.
 *
 * @package Mattwiebe\SLOProxy
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function arg( name, fallback ) {
	const idx = process.argv.indexOf( `--${ name }` );
	if ( idx === -1 || idx + 1 >= process.argv.length ) {
		return fallback;
	}
	return process.argv[ idx + 1 ];
}

function args( name ) {
	const values = [];

	for ( let i = 0; i < process.argv.length; i++ ) {
		if ( process.argv[ i ] === `--${ name }` && i + 1 < process.argv.length ) {
			values.push( process.argv[ i + 1 ] );
			i++;
		}
	}

	return values;
}

function hasFlag( name ) {
	return process.argv.includes( `--${ name }` );
}

const IS_INIT  = 'init' === process.argv[ 2 ];
const SCRIPT_DIR = dirname( fileURLToPath( import.meta.url ) );
const ENV_PATH = process.env.SLOPROXY_ENV_PATH
	|| join( homedir(), '.config', 'sloproxy', '.env' );
const PORT_ARG            = arg( 'port', '' );
const FUNNEL_PORT_ARG     = arg( 'funnel-port', '' );
const BACKEND_ARG         = arg( 'backend', '' );
const PROVIDER_ARGS       = args( 'provider' );
const TUNNEL_ARG          = arg( 'tunnel', '' );
const API_KEY_ARG         = arg( 'api-key', '' );
const NO_TUNNEL_FLAG      = hasFlag( 'no-tunnel' );
const TUNNEL_MODES        = [ 'local', 'tailscale', 'cloudflare' ];
const FUNNEL_PORT_CHOICES = [
	{ port: 8443, label: '8443 (default)' },
	{ port: 443, label: '443' },
	{ port: 10000, label: '10000' },
];
const ALLOWED_FUNNEL_PORTS = FUNNEL_PORT_CHOICES.map( ( choice ) => choice.port );
const PUBLIC_DNS_SERVERS = [ '1.1.1.1', '8.8.8.8' ];
const WORDPRESS_PLUGIN_RELEASES_URL = 'https://github.com/mattwiebe/ai-connector-for-local-ai/releases/latest';
let PORT = 13531;
let PROVIDERS = [];
let API_KEY = '';
let TUNNEL_MODE = 'local';
let IS_RESTARTING = false;

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

/**
 * Known local inference backends.
 */
const BACKENDS = [
	{
		name:     'Ollama',
		slug:     'ollama',
		cli:      'ollama',
		port:     11434,
		url:      'http://localhost:11434',
		probeUrl: 'http://localhost:11434/v1/models',
	},
	{
		name:     'LM Studio',
		slug:     'lmstudio',
		cli:      'lms',
		port:     1234,
		url:      'http://localhost:1234',
		probeUrl: 'http://localhost:1234/v1/models',
	},
];

const COMMON_PROVIDER_PORTS = [
	11434,
	1234,
	3000,
	3333,
	3434,
	4000,
	5000,
	5001,
	7860,
	8000,
	8080,
	8081,
	9000,
	10000,
];

function parseEnvFile( contents ) {
	const values = {};

	for ( const rawLine of contents.split( /\r?\n/ ) ) {
		const line = rawLine.trim();
		if ( '' === line || line.startsWith( '#' ) ) {
			continue;
		}

		const equalsIndex = line.indexOf( '=' );
		if ( -1 === equalsIndex ) {
			continue;
		}

		const key = line.slice( 0, equalsIndex ).trim();
		let value = line.slice( equalsIndex + 1 ).trim();

		if (
			( value.startsWith( '"' ) && value.endsWith( '"' ) ) ||
			( value.startsWith( '\'' ) && value.endsWith( '\'' ) )
		) {
			value = value.slice( 1, -1 );
		}

		values[ key ] = value;
	}

	return values;
}

function loadStoredConfig() {
	if ( ! existsSync( ENV_PATH ) ) {
		return {};
	}

	return parseEnvFile( readFileSync( ENV_PATH, 'utf8' ) );
}

function envValue( value ) {
	return JSON.stringify( String( value ) );
}

function providerEnvValue( providers ) {
	return providers.map( ( provider ) => `${ provider.slug }:${ provider.port }` ).join( ',' );
}

function writeConfig( config ) {
	mkdirSync( dirname( ENV_PATH ), { recursive: true } );

	const providers = Array.isArray( config.providers ) && config.providers.length > 0
		? config.providers
		: config.backendUrl
			? [ backendUrlToProvider( config.backendUrl ) ].filter( Boolean )
			: [];
	const firstProvider = providers[ 0 ] ?? null;
	const tunnelMode = getConfigTunnelMode( config );

	const contents = [
		'# SLOProxy configuration',
		`PORT=${ envValue( config.port ) }`,
		`TUNNEL_MODE=${ envValue( tunnelMode ) }`,
		`FUNNEL_PORT=${ envValue( config.funnelPort ) }`,
		`PROVIDERS=${ envValue( providerEnvValue( providers ) ) }`,
		`BACKEND_URL=${ envValue( firstProvider?.url ?? config.backendUrl ?? '' ) }`,
		`API_KEY=${ envValue( requiresApiKey( tunnelMode ) ? config.apiKey : '' ) }`,
		`NO_TUNNEL=${ envValue( 'local' === tunnelMode ? '1' : '0' ) }`,
		'',
	].join( '\n' );

	writeFileSync( ENV_PATH, contents, 'utf8' );
}

function parseNumberOrFallback( value, fallback ) {
	const parsed = Number( value );
	return Number.isFinite( parsed ) && parsed > 0 ? parsed : fallback;
}

function parsePortNumber( value ) {
	const normalized = String( value ).trim();
	if ( ! /^\d+$/.test( normalized ) ) {
		return null;
	}

	const port = Number( normalized );
	return Number.isInteger( port ) && port >= 1 && port <= 65535 ? port : null;
}

function buildLocalhostBackendUrl( port ) {
	const parsed = parsePortNumber( port );
	if ( null === parsed ) {
		return '';
	}

	return `http://localhost:${ parsed }`;
}

function parseBooleanEnv( value ) {
	return '1' === value || 'true' === value;
}

function normalizeTunnelMode( value ) {
	const normalized = String( value || '' ).trim().toLowerCase();
	return TUNNEL_MODES.includes( normalized ) ? normalized : 'local';
}

function getConfigTunnelMode( config ) {
	return normalizeTunnelMode(
		config.tunnelMode ?? ( config.noTunnel ? 'local' : 'tailscale' )
	);
}

function requiresApiKey( tunnelMode ) {
	return 'local' !== normalizeTunnelMode( tunnelMode );
}

function isValidTunnelMode( value ) {
	return TUNNEL_MODES.includes( String( value || '' ).trim().toLowerCase() );
}

function normalizeProviderSlug( value ) {
	return String( value || '' ).trim().toLowerCase();
}

function isValidProviderSlug( value ) {
	return /^[a-z0-9][a-z0-9_-]*$/.test( value );
}

function parseProviderSpecifier( value ) {
	const normalized = String( value || '' ).trim();
	const match = normalized.match( /^([A-Za-z0-9][A-Za-z0-9_-]*)[:=](\d+)$/ );
	if ( ! match ) {
		return null;
	}

	const slug = normalizeProviderSlug( match[ 1 ] );
	const port = parsePortNumber( match[ 2 ] );
	if ( ! isValidProviderSlug( slug ) || null === port ) {
		return null;
	}

	return {
		slug,
		port,
		url: buildLocalhostBackendUrl( port ),
	};
}

function parseProvidersEnv( value ) {
	return String( value || '' )
		.split( /[,\n;]/ )
		.map( ( entry ) => parseProviderSpecifier( entry ) )
		.filter( Boolean );
}

function normalizeProviderConfig( providers ) {
	ensureValidProviderConfig( providers );
	return providers;
}

function getProviderConfigError( providers ) {
	const seenSlugs = new Map();
	const seenPorts = new Map();

	for ( const provider of providers ) {
		if ( seenSlugs.has( provider.slug ) ) {
			return `Duplicate provider slug "${ provider.slug }". Each provider needs a unique slug.`;
		}

		if ( seenPorts.has( provider.port ) ) {
			return `Duplicate provider port ${ provider.port } for "${ seenPorts.get( provider.port ).slug }" and "${ provider.slug }". Each provider needs a unique localhost port.`;
		}

		seenSlugs.set( provider.slug, provider );
		seenPorts.set( provider.port, provider );
	}

	return null;
}

function ensureValidProviderConfig( providers ) {
	const error = getProviderConfigError( providers );
	if ( ! error ) {
		return;
	}

	console.error( `  Invalid provider configuration: ${ error }` );
	console.error( '' );
	process.exit( 1 );
}

function backendUrlToProvider( backendUrl, slug = 'local' ) {
	try {
		const url = new URL( backendUrl );
		const port = parsePortNumber( url.port || ( 'https:' === url.protocol ? '443' : '80' ) );
		if ( null === port ) {
			return null;
		}

		return {
			slug,
			port,
			url: url.origin,
		};
	} catch {
		return null;
	}
}

function getEffectiveConfig() {
	const stored = loadStoredConfig();
	const storedProviders = parseProvidersEnv( stored.PROVIDERS ?? '' );
	const legacyProvider = storedProviders.length > 0 || ! stored.BACKEND_URL
		? null
		: backendUrlToProvider( stored.BACKEND_URL );
	const providerArgs = PROVIDER_ARGS.map( parseProviderSpecifier );
	if ( providerArgs.some( ( provider ) => null === provider ) ) {
		console.error( '  Invalid --provider value. Use --provider <slug:port>, for example --provider ollama:11434.' );
		console.error( '' );
		process.exit( 1 );
	}
	const providerConfig = providerArgs.length > 0
		? providerArgs
		: storedProviders.length > 0
			? storedProviders
			: legacyProvider
				? [ legacyProvider ]
				: [];
	ensureValidProviderConfig( providerConfig );
	const config = {
		port: parseNumberOrFallback( stored.PORT, 13531 ),
		funnelPort: parseNumberOrFallback( stored.FUNNEL_PORT, 8443 ),
		providers: providerConfig,
		backendUrl: stored.BACKEND_URL ?? '',
		apiKey: stored.API_KEY ?? '',
		tunnelMode: parseBooleanEnv( stored.NO_TUNNEL ?? '0' )
			? 'local'
			: normalizeTunnelMode( stored.TUNNEL_MODE ?? 'tailscale' ),
	};

	if ( '' !== PORT_ARG ) {
		config.port = parseNumberOrFallback( PORT_ARG, config.port );
	}
	if ( '' !== BACKEND_ARG ) {
		const provider = backendUrlToProvider( BACKEND_ARG );
		config.backendUrl = BACKEND_ARG;
		config.providers = provider ? [ provider ] : [];
	}
	if ( '' !== API_KEY_ARG ) {
		config.apiKey = API_KEY_ARG;
	}
	if ( NO_TUNNEL_FLAG ) {
		config.tunnelMode = 'local';
	}
	if ( '' !== TUNNEL_ARG ) {
		if ( ! isValidTunnelMode( TUNNEL_ARG ) ) {
			console.error( `  Invalid --tunnel value: ${ TUNNEL_ARG }` );
			console.error( `  Allowed modes: ${ TUNNEL_MODES.join( ', ' ) }` );
			console.error( '' );
			process.exit( 1 );
		}
		config.tunnelMode = normalizeTunnelMode( TUNNEL_ARG );
	}
	if ( '' !== FUNNEL_PORT_ARG ) {
		const parsed = Number( FUNNEL_PORT_ARG );
		if ( ! ALLOWED_FUNNEL_PORTS.includes( parsed ) ) {
			console.error( `  Invalid --funnel-port value: ${ FUNNEL_PORT_ARG }` );
			console.error( `  Allowed ports: ${ ALLOWED_FUNNEL_PORTS.join( ', ' ) }` );
			console.error( '' );
			process.exit( 1 );
		}
		config.funnelPort = parsed;
	}

	if ( ! requiresApiKey( config.tunnelMode ) ) {
		config.apiKey = '';
	} else if ( '' === config.apiKey ) {
		config.apiKey = randomBytes( 32 ).toString( 'hex' );
	}
	config.noTunnel = 'local' === config.tunnelMode;
	config.backendUrl = config.providers[ 0 ]?.url ?? config.backendUrl;

	return config;
}

function hasUsableConfig( config ) {
	const hasProvider = Array.isArray( config.providers ) && config.providers.length > 0;
	const hasLegacyBackend = '' !== String( config.backendUrl ?? '' ).trim();
	const tunnelMode = getConfigTunnelMode( config );
	const hasApiKey = '' !== String( config.apiKey ?? '' ).trim();
	return ( hasProvider || hasLegacyBackend ) && ( ! requiresApiKey( tunnelMode ) || hasApiKey );
}

function buildPublicUrl( dnsName, publicPort ) {
	return 443 === publicPort
		? `https://${ dnsName }`
		: `https://${ dnsName }:${ publicPort }`;
}

/**
 * Check whether a CLI binary is available on PATH.
 */
function hasCli( bin ) {
	try {
		const cmd = process.platform === 'win32' ? 'where' : 'which';
		execFileSync( cmd, [ bin ], { stdio: 'ignore' } );
		return true;
	} catch {
		return false;
	}
}

/**
 * Try to reach a backend's probe URL and pull model names from the response.
 */
async function probeModels( probeUrl ) {
	try {
		const res = await fetch( probeUrl, { signal: AbortSignal.timeout( 3000 ) } );
		if ( ! res.ok ) return null;
		const json = await res.json();
		if ( Array.isArray( json?.data ) ) {
			return json.data.map( ( m ) => m.id ).filter( Boolean );
		}
		return [];
	} catch {
		return null;
	}
}

/**
 * Detect which backends are installed and running.
 */
async function detectBackends() {
	const results = [];
	const knownByPort = new Map( BACKENDS.map( ( backend ) => [ backend.port, backend ] ) );
	const ports = [ ...new Set( [ ...BACKENDS.map( ( backend ) => backend.port ), ...COMMON_PROVIDER_PORTS ] ) ];

	for ( const port of ports ) {
		const known = knownByPort.get( port );
		const backend = known ?? {
			name:     `Provider on port ${ port }`,
			slug:     `provider${ port }`,
			cli:      '',
			port,
			url:      buildLocalhostBackendUrl( port ),
			probeUrl: `${ buildLocalhostBackendUrl( port ) }/v1/models`,
		};
		const installed = backend.cli ? hasCli( backend.cli ) : false;
		let running = false;
		let models  = null;

		models = await probeModels( backend.probeUrl );
		running = models !== null;

		results.push( { ...backend, installed, running, models } );
	}

	return results;
}

/**
 * Prompt the user to pick from a list of choices. Returns the 0-based index.
 */
function promptChoice( question, choices, defaultIndex = null ) {
	const rl = createInterface( { input: process.stdin, output: process.stdout } );

	for ( let i = 0; i < choices.length; i++ ) {
		console.log( `    ${ i + 1 }. ${ choices[ i ] }` );
	}
	console.log( '' );

	return new Promise( ( resolve ) => {
		function ask() {
			rl.question( question, ( answer ) => {
				if ( '' === answer.trim() && defaultIndex !== null ) {
					rl.close();
					resolve( defaultIndex );
					return;
				}

				const n = parseInt( answer, 10 );
				if ( n >= 1 && n <= choices.length ) {
					rl.close();
					resolve( n - 1 );
				} else {
					ask();
				}
			} );
		}
		ask();
	} );
}

function promptText( question ) {
	const rl = createInterface( { input: process.stdin, output: process.stdout } );

	return new Promise( ( resolve ) => {
		rl.question( question, ( answer ) => {
			rl.close();
			resolve( answer.trim() );
		} );
	} );
}

async function promptBackendPort() {
	while ( true ) {
		const answer = await promptText( '  Backend localhost port? ' );
		const port = parsePortNumber( answer );
		if ( null !== port ) {
			console.log( '' );
			return port;
		}

		console.error( '  Enter a port from 1 to 65535.' );
		console.error( '' );
	}
}

async function promptProviderSlug( defaultSlug = '' ) {
	while ( true ) {
		const suffix = defaultSlug ? ` [${ defaultSlug }]` : '';
		const answer = await promptText( `  Provider slug${ suffix }? ` );
		const slug = normalizeProviderSlug( answer || defaultSlug );
		if ( isValidProviderSlug( slug ) ) {
			return slug;
		}

		console.error( '  Use lowercase letters, numbers, dashes, or underscores, starting with a letter or number.' );
		console.error( '' );
	}
}

async function promptProvider( defaultSlug = '' ) {
	const slug = await promptProviderSlug( defaultSlug );
	const port = await promptBackendPort();

	return {
		slug,
		port,
		url: buildLocalhostBackendUrl( port ),
	};
}

async function promptAdditionalProviders( providers = [] ) {
	const configured = [ ...providers ];

	while ( configured.length === 0 || await promptYesNo( '  Add another local inference provider?', false ) ) {
		console.log( '' );
		configured.push( await promptProvider() );
	}

	return normalizeProviderConfig( configured );
}

/**
 * Resolve which public HTTPS port to use for Tailscale Funnel.
 */
async function resolveFunnelPort() {
	console.log( '  Choose a public Tailscale Funnel port:' );
	console.log( '' );

	const choices = FUNNEL_PORT_CHOICES.map( ( choice ) => choice.label );

	const idx = await promptChoice( '  Which public HTTPS port? [1]: ', choices, 0 );
	console.log( '' );

	return FUNNEL_PORT_CHOICES[ idx ].port;
}

async function resolveTunnelMode() {
	if ( NO_TUNNEL_FLAG ) {
		return 'local';
	}

	if ( '' !== TUNNEL_ARG ) {
		const mode = normalizeTunnelMode( TUNNEL_ARG );
		if ( ! isValidTunnelMode( TUNNEL_ARG ) ) {
			console.error( `  Invalid --tunnel value: ${ TUNNEL_ARG }` );
			console.error( `  Allowed modes: ${ TUNNEL_MODES.join( ', ' ) }` );
			console.error( '' );
			process.exit( 1 );
		}
		return mode;
	}

	console.log( '  Choose how to expose the proxy:' );
	console.log( '' );

	const idx = await promptChoice(
		'  Exposure mode? [1]: ',
		[
			'Local only',
			'Tailscale Funnel',
			'Cloudflare Tunnel',
		],
		0
	);
	console.log( '' );

	return [ 'local', 'tailscale', 'cloudflare' ][ idx ];
}

/**
 * Resolve which provider list to use.
 */
async function resolveProviders() {
	if ( PROVIDER_ARGS.length > 0 ) {
		const providers = PROVIDER_ARGS.map( parseProviderSpecifier ).filter( Boolean );
		if ( providers.length !== PROVIDER_ARGS.length ) {
			console.error( '  Invalid --provider value. Use --provider <slug:port>, for example --provider ollama:11434.' );
			console.error( '' );
			process.exit( 1 );
		}

		return normalizeProviderConfig( providers );
	}

	if ( BACKEND_ARG ) {
		const provider = backendUrlToProvider( BACKEND_ARG );
		if ( ! provider ) {
			console.error( `  Invalid --backend value: ${ BACKEND_ARG }` );
			console.error( '' );
			process.exit( 1 );
		}

		return [ provider ];
	}

	console.log( '' );
	console.log( '  Scanning local OpenAI-compatible providers...' );
	console.log( '' );

	const detected = await detectBackends();
	const running = detected.filter( ( b ) => b.running );
	const installed = detected.filter( ( b ) => b.installed && ! b.running );

	if ( running.length > 0 ) {
		const providers = running.map( ( b ) => ( {
			slug: b.slug,
			port: b.port,
			url: b.url,
		} ) );

		console.log( `  Found ${ running.length } active provider${ running.length === 1 ? '' : 's' }:` );
		for ( const b of running ) {
			const modelCount = b.models?.length ?? 0;
			const modelInfo = modelCount > 0
				? ` - ${ modelCount } model${ modelCount === 1 ? '' : 's' }: ${ b.models.join( ', ' ) }`
				: '';
			console.log( `    ${ b.slug }:${ b.port } (${ b.name })${ modelInfo }` );
		}
		console.log( '' );

		if ( await promptYesNo( '  Configure all active providers?', true ) ) {
			console.log( '' );
			return promptAdditionalProviders( providers );
		}

		console.log( '' );
		return promptAdditionalProviders();
	}

	if ( installed.length > 0 ) {
		console.error( '  Found installed but not running:' );
		for ( const b of installed ) {
			const startHint = b.cli === 'ollama' ? 'ollama serve' : 'lms server start';
			console.error( `    ${ b.name } (${ b.cli }) - start it with: ${ startHint }` );
		}
		console.error( '' );
	}

	console.error( '  No active OpenAI-compatible providers found on common localhost ports.' );
	console.error( '  Enter each provider by slug and port.' );
	console.error( '' );
	return promptAdditionalProviders();
}

async function promptYesNo( question, defaultValue = true ) {
	const rl = createInterface( { input: process.stdin, output: process.stdout } );
	const suffix = defaultValue ? ' [Y/n]: ' : ' [y/N]: ';

	return new Promise( ( resolve ) => {
		rl.question( `${ question }${ suffix }`, ( answer ) => {
			rl.close();

			const normalized = answer.trim().toLowerCase();
			if ( '' === normalized ) {
				resolve( defaultValue );
				return;
			}

			resolve( 'y' === normalized || 'yes' === normalized );
		} );
	} );
}

async function runInit() {
	console.log( '' );
	console.log( '  Initializing SLOProxy configuration...' );
	console.log( '' );

	const tunnelMode = await resolveTunnelMode();

	const config = {
		port: '' !== PORT_ARG ? parseNumberOrFallback( PORT_ARG, 13531 ) : 13531,
		funnelPort: 'tailscale' !== tunnelMode
			? 8443
			: '' !== FUNNEL_PORT_ARG
				? Number( FUNNEL_PORT_ARG )
				: await resolveFunnelPort(),
		providers: await resolveProviders(),
		apiKey: requiresApiKey( tunnelMode )
			? '' !== API_KEY_ARG
				? API_KEY_ARG
				: randomBytes( 32 ).toString( 'hex' )
			: '',
		tunnelMode,
	};
	config.noTunnel = 'local' === tunnelMode;
	config.backendUrl = config.providers[ 0 ]?.url ?? '';

	if ( 'tailscale' === config.tunnelMode && ! ALLOWED_FUNNEL_PORTS.includes( config.funnelPort ) ) {
		console.error( `  Invalid funnel port: ${ config.funnelPort }` );
		console.error( `  Allowed ports: ${ ALLOWED_FUNNEL_PORTS.join( ', ' ) }` );
		console.error( '' );
		process.exit( 1 );
	}

	writeConfig( config );

	console.log( `  Saved configuration to ${ ENV_PATH }` );
	console.log( '' );

	return config;
}

// ---------------------------------------------------------------------------
// Public exposure
// ---------------------------------------------------------------------------

/**
 * Check if Tailscale is installed and get its status.
 */
function getTailscaleStatus() {
	try {
		const output = execFileSync( 'tailscale', [ 'status', '--json' ], {
			encoding: 'utf-8',
			timeout: 5000,
		} );
		return JSON.parse( output );
	} catch {
		return null;
	}
}

/**
 * Get the Tailscale DNS name for this machine.
 */
function getTailscaleDnsName() {
	const status = getTailscaleStatus();
	if ( ! status?.Self?.DNSName ) {
		return null;
	}
	// DNSName has a trailing dot — remove it.
	return status.Self.DNSName.replace( /\.$/, '' );
}

async function resolvePublicDnsRecords( dnsName, servers = PUBLIC_DNS_SERVERS ) {
	const records = [];

	for ( const server of servers ) {
		const resolver = new Resolver();
		resolver.setServers( [ server ] );

		try {
			records.push( ...await resolver.resolve4( dnsName ) );
		} catch {
			// Try the next record type/server.
		}

		try {
			records.push( ...await resolver.resolve6( dnsName ) );
		} catch {
			// Try the next server.
		}

		if ( records.length > 0 ) {
			break;
		}
	}

	return records;
}

async function warnIfPublicDnsUnavailable( dnsName, publicUrl ) {
	const records = await resolvePublicDnsRecords( dnsName );
	if ( records.length > 0 ) {
		return;
	}

	console.warn( '  Warning: Public DNS does not resolve this Funnel hostname yet.' );
	console.warn( `  WordPress may report "Could not resolve host: ${ dnsName }" for ${ publicUrl }.` );
	console.warn( '  Tailscale says Funnel DNS propagation can take up to 10 minutes.' );
	console.warn( '  If it still fails after that, check that Funnel, MagicDNS, HTTPS certificates, and your Funnel policy are enabled in Tailscale.' );
	console.warn( '' );
}

/**
 * Start Tailscale Funnel for the local proxy. Returns the public HTTPS URL.
 */
function startTailscaleFunnel( localPort, publicPort ) {
	const dnsName = getTailscaleDnsName();
	if ( ! dnsName ) {
		console.error( '  Error: Could not determine your Tailscale DNS name.' );
		console.error( '  Make sure Tailscale is running: tailscale up' );
		console.error( '' );
		process.exit( 1 );
	}

	console.log( `  Starting Tailscale Funnel on public port ${ publicPort }...` );

	// Run `tailscale funnel` in the background — it stays running.
	const child = execFile(
		'tailscale',
		[ 'funnel', '--bg', `--https=${ publicPort }`, String( localPort ) ],
		{ timeout: 15000 },
		( err, stdout, stderr ) => {
			if ( err ) {
				// The --bg flag may not be available in older versions.
				// If it fails, we'll try without it below.
				if ( stderr?.includes( 'unknown flag' ) ) {
					return;
				}
				// Non-fatal: funnel may already be running.
			}
		}
	);

	// Detach so it doesn't block shutdown.
	child.unref();

	const publicUrl = buildPublicUrl( dnsName, publicPort );
	return {
		publicUrl,
		dnsName,
		stop: () => {},
	};
}

/**
 * Ensure Tailscale is available, or guide the user to install it.
 */
function ensureTailscale() {
	if ( hasCli( 'tailscale' ) ) {
		const status = getTailscaleStatus();
		if ( ! status ) {
			console.error( '' );
			console.error( '  Tailscale is installed but not running.' );
			console.error( '  Start it with:' );
			console.error( '' );
			if ( process.platform === 'darwin' ) {
				console.error( '    open /Applications/Tailscale.app' );
			} else if ( process.platform === 'linux' ) {
				console.error( '    sudo tailscale up' );
			} else {
				console.error( '    tailscale up' );
			}
			console.error( '' );
			console.error( '  Then re-run this script.' );
			console.error( '' );
			process.exit( 1 );
		}
		return;
	}

	console.error( '' );
	console.error( '  Tailscale is required but not installed.' );
	console.error( '' );
	console.error( '  Install Tailscale:' );
	if ( process.platform === 'darwin' ) {
		console.error( '    brew install tailscale' );
		console.error( '    — or —' );
		console.error( '    https://tailscale.com/download/mac' );
	} else if ( process.platform === 'linux' ) {
		console.error( '    curl -fsSL https://tailscale.com/install.sh | sh' );
	} else if ( process.platform === 'win32' ) {
		console.error( '    https://tailscale.com/download/windows' );
	} else {
		console.error( '    https://tailscale.com/download' );
	}
	console.error( '' );
	console.error( '  After installing, run `tailscale up` and then re-run this script.' );
	console.error( '' );
	process.exit( 1 );
}

function ensureCloudflared() {
	if ( hasCli( 'cloudflared' ) ) {
		return;
	}

	console.error( '' );
	console.error( '  Cloudflare Tunnel was requested, but cloudflared is not installed.' );
	console.error( '' );
	console.error( '  Install cloudflared:' );
	if ( process.platform === 'darwin' ) {
		console.error( '    brew install cloudflared' );
	} else {
		console.error( '    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' );
	}
	console.error( '' );
	process.exit( 1 );
}

function extractCloudflareTunnelUrl( chunk ) {
	const match = String( chunk ).match( /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i );
	return match ? match[ 0 ] : null;
}

function startCloudflareTunnel( localPort ) {
	ensureCloudflared();
	console.log( '  Starting Cloudflare Tunnel...' );

	const child = spawn(
		'cloudflared',
		[ 'tunnel', '--url', `http://127.0.0.1:${ localPort }` ],
		{
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		}
	);

	let settled = false;
	let publicUrl = null;

	const stop = () => {
		if ( ! child.killed ) {
			child.kill( 'SIGTERM' );
		}
	};

	const waitForUrl = new Promise( ( resolve, reject ) => {
		const timeout = setTimeout( () => {
			if ( settled ) {
				return;
			}
			settled = true;
			resolve( null );
		}, 15000 );

		function handleOutput( chunk ) {
			const found = extractCloudflareTunnelUrl( chunk );
			if ( ! found || settled ) {
				return;
			}

			publicUrl = found;
			settled = true;
			clearTimeout( timeout );
			resolve( found );
		}

		child.stdout.on( 'data', handleOutput );
		child.stderr.on( 'data', handleOutput );
		child.on( 'error', ( error ) => {
			if ( settled ) {
				return;
			}
			settled = true;
			clearTimeout( timeout );
			reject( error );
		} );
		child.on( 'exit', ( code ) => {
			if ( settled ) {
				return;
			}
			settled = true;
			clearTimeout( timeout );
			reject( new Error( `cloudflared exited before creating a tunnel (code ${ code ?? 'unknown' })` ) );
		} );
	} );

	return {
		publicUrl: waitForUrl.then( () => publicUrl ),
		stop,
	};
}

async function startTunnel( config ) {
	if ( 'tailscale' === config.tunnelMode ) {
		ensureTailscale();
		return startTailscaleFunnel( config.port, config.funnelPort );
	}

	if ( 'cloudflare' === config.tunnelMode ) {
		const tunnel = startCloudflareTunnel( config.port );
		return {
			publicUrl: await tunnel.publicUrl,
			stop: tunnel.stop,
		};
	}

	return {
		publicUrl: null,
		stop: () => {},
	};
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------

function normalizeRemoteAddress( address ) {
	if ( ! address ) {
		return 'unknown';
	}

	return address.startsWith( '::ffff:' )
		? address.slice( 7 )
		: address;
}

function extractOriginHost( value ) {
	if ( ! value ) {
		return '';
	}

	const normalized = String( value );
	if ( ! normalized.includes( '://' ) ) {
		return normalized;
	}

	try {
		return new URL( normalized ).host;
	} catch {
		return normalized;
	}
}

function getRequestSource( req ) {
	const forwardedForHeader = req.headers['x-forwarded-for'];
	const forwardedFor = Array.isArray( forwardedForHeader )
		? forwardedForHeader[ 0 ]
		: forwardedForHeader;
	const remoteAddress = normalizeRemoteAddress(
		( forwardedFor || '' ).split( ',' )[ 0 ].trim() || req.socket?.remoteAddress || ''
	);
	const originHost = extractOriginHost(
		req.headers.origin ||
		req.headers.referer ||
		req.headers['x-forwarded-host'] ||
		req.headers.host ||
		''
	);

	return originHost && originHost !== remoteAddress
		? `${ originHost } (${ remoteAddress })`
		: remoteAddress;
}

function formatRequestLogMessage( req, statusCode ) {
	const timestamp = new Date().toISOString();
	const method = req.method || 'GET';
	const path = req.url || '/';
	const source = getRequestSource( req );

	return `  [${ timestamp }] ${ statusCode } ${ method } ${ path } from ${ source }`;
}

function logRequest( req, statusCode ) {
	console.log( formatRequestLogMessage( req, statusCode ) );
}

function findProviderBySlug( slug ) {
	return PROVIDERS.find( ( provider ) => provider.slug === slug ) ?? null;
}

function splitPrefixedModel( model ) {
	const normalized = String( model || '' );
	const separatorIndex = normalized.indexOf( '/' );
	if ( -1 === separatorIndex ) {
		return null;
	}

	return {
		slug: normalized.slice( 0, separatorIndex ),
		model: normalized.slice( separatorIndex + 1 ),
	};
}

function providerFromModel( model ) {
	const prefixed = splitPrefixedModel( model );
	if ( prefixed ) {
		const provider = findProviderBySlug( prefixed.slug );
		return provider
			? { provider, model: prefixed.model, wasPrefixed: true }
			: null;
	}

	if ( 1 === PROVIDERS.length ) {
		return { provider: PROVIDERS[ 0 ], model, wasPrefixed: false };
	}

	return null;
}

function jsonResponse( res, statusCode, body ) {
	res.writeHead( statusCode, { 'Content-Type': 'application/json' } );
	res.end( JSON.stringify( body ) );
}

function routeModelPath( pathname ) {
	const prefix = '/v1/models/';
	if ( ! pathname.startsWith( prefix ) ) {
		return null;
	}

	const model = decodeURIComponent( pathname.slice( prefix.length ) );
	const routed = providerFromModel( model );
	if ( ! routed ) {
		return null;
	}

	return {
		provider: routed.provider,
		pathname: `${ prefix }${ encodeURIComponent( routed.model ) }`,
	};
}

async function proxyModelsList( req, res ) {
	const data = [];
	const errors = [];

	for ( const provider of PROVIDERS ) {
		try {
			const upstream = await fetch( `${ provider.url }/v1/models`, {
				headers: {
					accept: req.headers.accept || 'application/json',
				},
				signal: AbortSignal.timeout( 5000 ),
			} );

			if ( ! upstream.ok ) {
				errors.push( `${ provider.slug}: HTTP ${ upstream.status }` );
				continue;
			}

			const json = await upstream.json();
			if ( ! Array.isArray( json?.data ) ) {
				errors.push( `${ provider.slug}: invalid /v1/models response` );
				continue;
			}

			for ( const model of json.data ) {
				if ( ! model?.id ) {
					continue;
				}

				data.push( {
					...model,
					id: `${ provider.slug }/${ model.id }`,
				} );
			}
		} catch ( error ) {
			errors.push( `${ provider.slug}: ${ error.message }` );
		}
	}

	if ( data.length === 0 && errors.length > 0 ) {
		jsonResponse( res, 502, {
			error: 'No configured providers returned models',
			detail: errors,
		} );
		logRequest( req, 502 );
		return;
	}

	jsonResponse( res, 200, {
		object: 'list',
		data,
	} );
	logRequest( req, 200 );
}

function rewriteJsonModelBody( body ) {
	if ( 0 === body.length ) {
		return {
			body,
			provider: 1 === PROVIDERS.length ? PROVIDERS[ 0 ] : null,
		};
	}

	let json;
	try {
		json = JSON.parse( body.toString( 'utf8' ) );
	} catch {
		return {
			body,
			provider: 1 === PROVIDERS.length ? PROVIDERS[ 0 ] : null,
		};
	}

	if ( 'string' !== typeof json.model ) {
		return {
			body,
			provider: 1 === PROVIDERS.length ? PROVIDERS[ 0 ] : null,
		};
	}

	const routed = providerFromModel( json.model );
	if ( ! routed ) {
		return {
			body,
			provider: null,
			error: `Unknown or missing provider prefix in model "${ json.model }". Use one of: ${ PROVIDERS.map( ( p ) => p.slug ).join( ', ' ) }`,
		};
	}

	if ( routed.wasPrefixed ) {
		json.model = routed.model;
		return {
			body: Buffer.from( JSON.stringify( json ) ),
			provider: routed.provider,
		};
	}

	return {
		body,
		provider: routed.provider,
	};
}

async function handler( req, res ) {
	// Authenticate.
	const auth = req.headers.authorization || '';
	if ( requiresApiKey( TUNNEL_MODE ) && auth !== `Bearer ${ API_KEY }` ) {
		jsonResponse( res, 401, { error: 'Unauthorized' } );
		logRequest( req, 401 );
		return;
	}

	const requestUrl = new URL( req.url, 'http://localhost' );
	if ( 'GET' === req.method && '/v1/models' === requestUrl.pathname ) {
		await proxyModelsList( req, res );
		return;
	}

	let provider = null;
	let body;

	const modelPathRoute = routeModelPath( requestUrl.pathname );
	if ( modelPathRoute ) {
		provider = modelPathRoute.provider;
		requestUrl.pathname = modelPathRoute.pathname;
	} else if ( req.method !== 'GET' && req.method !== 'HEAD' ) {
		body = await readBody( req );
		const rewrite = rewriteJsonModelBody( body );
		if ( rewrite.error ) {
			jsonResponse( res, 400, { error: rewrite.error } );
			logRequest( req, 400 );
			return;
		}
		provider = rewrite.provider;
		body = rewrite.body;
	} else if ( 1 === PROVIDERS.length ) {
		provider = PROVIDERS[ 0 ];
	}

	if ( ! provider ) {
		jsonResponse( res, 400, {
			error: `Request must include a provider-prefixed model. Use one of: ${ PROVIDERS.map( ( p ) => p.slug ).join( ', ' ) }`,
		} );
		logRequest( req, 400 );
		return;
	}

	// Build upstream URL.
	const upstreamUrl = new URL( `${ requestUrl.pathname }${ requestUrl.search }`, provider.url );

	// Forward headers, minus hop-by-hop ones.
	const forwardHeaders = { ...req.headers };
	delete forwardHeaders.host;
	delete forwardHeaders.authorization;
	delete forwardHeaders.connection;
	delete forwardHeaders['content-length'];
	forwardHeaders.host = upstreamUrl.host;
	if ( body ) {
		forwardHeaders['content-length'] = String( body.length );
	}

	try {
		const upstream = await fetch( upstreamUrl.href, {
			method: req.method,
			headers: forwardHeaders,
			body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
			redirect: 'manual',
		} );

		// Relay status + headers.
		const relayHeaders = {};
		upstream.headers.forEach( ( value, key ) => {
			if ( key === 'transfer-encoding' ) return;
			relayHeaders[ key ] = value;
		} );

		res.writeHead( upstream.status, relayHeaders );

		if ( upstream.body ) {
			const reader = upstream.body.getReader();
			async function pump() {
				const { done, value } = await reader.read();
				if ( done ) {
					res.end();
					logRequest( req, upstream.status );
					return;
				}
				res.write( value );
				await pump();
			}
			await pump();
		} else {
			res.end();
			logRequest( req, upstream.status );
		}
	} catch ( err ) {
		jsonResponse( res, 502, { error: 'Backend unreachable', detail: err.message } );
		logRequest( req, 502 );
	}
}

function readBody( req ) {
	return new Promise( ( resolve, reject ) => {
		const chunks = [];
		req.on( 'data', ( c ) => chunks.push( c ) );
		req.on( 'end', () => resolve( Buffer.concat( chunks ) ) );
		req.on( 'error', reject );
	} );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function loadConfigForStartup() {
	const hasStoredConfig = existsSync( ENV_PATH );
	const storedConfig = hasStoredConfig ? getEffectiveConfig() : null;
	return IS_INIT || ! storedConfig || ! hasUsableConfig( storedConfig )
		? await runInit()
		: storedConfig;
}

function listen( server, port ) {
	return new Promise( ( resolve, reject ) => {
		server.once( 'error', reject );
		server.listen( port, '0.0.0.0', () => {
			server.off( 'error', reject );
			resolve();
		} );
	} );
}

function closeServer( server ) {
	return new Promise( ( resolve ) => {
		server.close( () => resolve() );
	} );
}

function printStartupInfo( config, publicUrl, funnelDnsName ) {
	console.log( '' );
	console.log( '  SLOProxy Proxy' );
	console.log( '  ----------------------------------------' );
	console.log( `  Listening on   http://0.0.0.0:${ PORT }` );
	console.log( `  Providers      ${ PROVIDERS.map( ( provider ) => `${ provider.slug } -> ${ provider.url }` ).join( ', ' ) }` );
	console.log( `  Tunnel Mode    ${ TUNNEL_MODE }` );
	if ( publicUrl ) {
		console.log( `  Public URL     ${ publicUrl }` );
		console.log( `  Public Route   ${ publicUrl } -> http://127.0.0.1:${ PORT }` );
	}
	console.log( `  API Key        ${ requiresApiKey( TUNNEL_MODE ) ? API_KEY : '(not required for local mode)' }` );
	console.log( '  ----------------------------------------' );
	console.log( '' );
	console.log( '  In your WordPress admin, set:' );
	if ( publicUrl ) {
		console.log( `    Endpoint URL:  ${ publicUrl }` );
		if ( 'tailscale' === TUNNEL_MODE ) {
			console.log( `    Note:          Tailscale Funnel listens on public port ${ config.funnelPort } and forwards to local port ${ PORT }` );
		}
	} else {
		console.log( `    Endpoint URL:  http://127.0.0.1:${ PORT }` );
	}
	if ( requiresApiKey( TUNNEL_MODE ) ) {
		console.log( `    API Key:       ${ API_KEY }` );
	} else {
		console.log( '    API Key:       not required for local mode' );
	}
	console.log( '' );
	console.log( '  Local smoke test:' );
	if ( requiresApiKey( TUNNEL_MODE ) ) {
		console.log( `    curl -H "Authorization: Bearer ${ API_KEY }" http://127.0.0.1:${ PORT }/v1/models` );
	} else {
		console.log( `    curl http://127.0.0.1:${ PORT }/v1/models` );
	}
	console.log( '' );
	console.log( '  Model IDs are prefixed by provider slug, for example:' );
	console.log( `    ${ PROVIDERS[ 0 ]?.slug ?? 'ollama' }/<model-id>` );
	console.log( '' );
	console.log( '  Recommended next steps:' );
	console.log( '    Run `sloproxy install` to keep the proxy running in the background on macOS.' );
	console.log( `    Download the WordPress plugin ZIP at ${ WORDPRESS_PLUGIN_RELEASES_URL }` );
	console.log( '    Request logs will appear below with endpoint path and caller IP/host.' );
	console.log( '' );

	if ( funnelDnsName && publicUrl ) {
		warnIfPublicDnsUnavailable( funnelDnsName, publicUrl ).catch( () => {} );
	}
}

async function startRuntime() {
	const config = await loadConfigForStartup();
	PORT = config.port;
	PROVIDERS = config.providers;
	API_KEY = config.apiKey;
	TUNNEL_MODE = config.tunnelMode;

	const tunnel = await startTunnel( config );
	const funnelDnsName = 'tailscale' === TUNNEL_MODE ? getTailscaleDnsName() : null;
	const publicUrl = tunnel.publicUrl;

	const server = createServer( handler );
	await listen( server, PORT );
	printStartupInfo( config, publicUrl, funnelDnsName );

	return {
		server,
		tunnel,
	};
}

async function restartRuntime( runtime ) {
	if ( IS_RESTARTING ) {
		return runtime;
	}

	IS_RESTARTING = true;
	console.log( '' );
	console.log( `  ${ ENV_PATH } changed; restarting proxy...` );
	console.log( '' );

	runtime.tunnel.stop();
	await closeServer( runtime.server );

	try {
		const nextRuntime = await startRuntime();
		console.log( '  Restart complete.' );
		console.log( '' );
		return nextRuntime;
	} finally {
		IS_RESTARTING = false;
	}
}

async function main() {
	let runtime = await startRuntime();

	watchFile( ENV_PATH, { interval: 1000 }, async ( current, previous ) => {
		if ( current.mtimeMs === previous.mtimeMs ) {
			return;
		}

		runtime = await restartRuntime( runtime );
	} );

	process.on( 'SIGINT', () => {
		console.log( '\n  Shutting down...' );
		runtime.tunnel.stop();
		runtime.server.close();
		process.exit( 0 );
	} );
}

const IS_DIRECT_RUN = process.argv[ 1 ] && fileURLToPath( import.meta.url ) === process.argv[ 1 ];

if ( IS_DIRECT_RUN ) {
	main();
}

export {
	ENV_PATH,
	buildLocalhostBackendUrl,
	buildPublicUrl,
	formatRequestLogMessage,
	FUNNEL_PORT_CHOICES,
	getEffectiveConfig,
	getProviderConfigError,
	getRequestSource,
	hasUsableConfig,
	parseBooleanEnv,
	parseEnvFile,
	parseNumberOrFallback,
	parsePortNumber,
	parseProviderSpecifier,
	parseProvidersEnv,
	WORDPRESS_PLUGIN_RELEASES_URL,
	providerFromModel,
	requiresApiKey,
	rewriteJsonModelBody,
	TUNNEL_MODES,
	writeConfig,
};
