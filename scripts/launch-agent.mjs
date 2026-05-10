#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_PATH as DEFAULT_ENV_PATH, getEffectiveConfig, hasUsableConfig, requiresApiKey, writeConfig } from '../local/server.mjs';

const SCRIPT_DIR = dirname( fileURLToPath( import.meta.url ) );
const ROOT_DIR = dirname( SCRIPT_DIR );
const BIN_PATH = join( ROOT_DIR, 'bin', 'sloproxy.mjs' );
const PACKAGE_JSON = JSON.parse( readFileSync( join( ROOT_DIR, 'package.json' ), 'utf8' ) );
const VERSION = PACKAGE_JSON.version;
const LABEL = 'com.mattwiebe.sloproxy';
const LAUNCH_AGENTS_DIR = join( homedir(), 'Library', 'LaunchAgents' );
const PLIST_PATH = join( LAUNCH_AGENTS_DIR, `${ LABEL }.plist` );
const LOG_DIR = join( homedir(), 'Library', 'Logs', 'sloproxy' );
const STDOUT_PATH = join( LOG_DIR, 'stdout.log' );
const STDERR_PATH = join( LOG_DIR, 'stderr.log' );
const ENV_PATH = process.env.SLOPROXY_ENV_PATH || DEFAULT_ENV_PATH;
const UID = typeof process.getuid === 'function' ? String( process.getuid() ) : '';
const DOMAIN = UID ? `gui/${ UID }` : '';
const SERVICE_TARGET = DOMAIN ? `${ DOMAIN }/${ LABEL }` : '';

function requireMacOs() {
	if ( process.platform !== 'darwin' ) {
		console.error( 'LaunchAgent management is only supported on macOS.' );
		process.exit( 1 );
	}
}

function launchctl( args, options = {} ) {
	return execFileSync( 'launchctl', args, {
		encoding: 'utf8',
		stdio: options.stdio ?? 'pipe',
	} );
}

function isLoaded() {
	if ( ! SERVICE_TARGET ) {
		return false;
	}

	try {
		launchctl( [ 'print', SERVICE_TARGET ] );
		return true;
	} catch {
		return false;
	}
}

function ensureConfigReady() {
	const config = getEffectiveConfig();
	if ( ! hasUsableConfig( config ) ) {
		console.error( `Configuration is not ready at ${ ENV_PATH }.` );
		console.error( 'Run `npm run init` or `sloproxy init` first.' );
		process.exit( 1 );
	}

	return config;
}

function xmlEscape( value ) {
	return String( value )
		.replaceAll( '&', '&amp;' )
		.replaceAll( '<', '&lt;' )
		.replaceAll( '>', '&gt;' )
		.replaceAll( '"', '&quot;' )
		.replaceAll( '\'', '&apos;' );
}

function plistArray( values ) {
	return values.map( ( value ) => `\t\t<string>${ xmlEscape( value ) }</string>` ).join( '\n' );
}

function plistEnv( entries ) {
	return Object.entries( entries )
		.map( ( [ key, value ] ) => `\t\t<key>${ xmlEscape( key ) }</key>\n\t\t<string>${ xmlEscape( value ) }</string>` )
		.join( '\n' );
}

function buildPlist() {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${ xmlEscape( LABEL ) }</string>
\t<key>ProgramArguments</key>
\t<array>
${ plistArray( [ process.execPath, BIN_PATH, 'up' ] ) }
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${ plistEnv( {
		PATH: process.env.PATH || '',
		SLOPROXY_ENV_PATH: ENV_PATH,
	} ) }
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${ xmlEscape( ROOT_DIR ) }</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${ xmlEscape( STDOUT_PATH ) }</string>
\t<key>StandardErrorPath</key>
\t<string>${ xmlEscape( STDERR_PATH ) }</string>
</dict>
</plist>
`;
}

function writePlist() {
	mkdirSync( LAUNCH_AGENTS_DIR, { recursive: true } );
	mkdirSync( LOG_DIR, { recursive: true } );
	writeFileSync( PLIST_PATH, buildPlist(), 'utf8' );
}

function stopService( { silent = false } = {} ) {
	if ( ! isLoaded() ) {
		if ( ! silent ) {
			console.log( `SLOProxy is not running via launchd (${ LABEL}).` );
		}
		return false;
	}

	launchctl( [ 'bootout', SERVICE_TARGET ] );
	if ( ! silent ) {
		console.log( `Stopped ${ LABEL }.` );
	}
	return true;
}

function startService() {
	if ( ! existsSync( PLIST_PATH ) ) {
		console.error( `LaunchAgent is not installed at ${ PLIST_PATH }.` );
		console.error( 'Run `npm run service:install` or `sloproxy install` first.' );
		process.exit( 1 );
	}

	ensureConfigReady();

	if ( isLoaded() ) {
		launchctl( [ 'kickstart', '-k', SERVICE_TARGET ] );
	} else {
		launchctl( [ 'bootstrap', DOMAIN, PLIST_PATH ] );
	}

	console.log( `Started ${ LABEL }.` );
	console.log( `Logs: ${ LOG_DIR }` );
}

function installService() {
	ensureConfigReady();
	writePlist();
	stopService( { silent: true } );
	launchctl( [ 'bootstrap', DOMAIN, PLIST_PATH ] );
	launchctl( [ 'kickstart', '-k', SERVICE_TARGET ] );

	console.log( `Installed LaunchAgent ${ LABEL }.` );
	console.log( `Plist: ${ PLIST_PATH }` );
	console.log( `Config: ${ ENV_PATH }` );
	console.log( `Logs: ${ LOG_DIR }` );
}

function uninstallService() {
	stopService( { silent: true } );

	if ( existsSync( PLIST_PATH ) ) {
		rmSync( PLIST_PATH );
	}

	console.log( `Removed LaunchAgent ${ LABEL }.` );
}

function statusService() {
	console.log( `sloproxy v${ VERSION }` );
	console.log( `Label: ${ LABEL }` );
	console.log( `Plist: ${ PLIST_PATH }` );
	console.log( `Config: ${ ENV_PATH }` );
	console.log( `Logs: ${ LOG_DIR }` );
	console.log( `Installed: ${ existsSync( PLIST_PATH ) ? 'yes' : 'no' }` );
	console.log( `Loaded: ${ isLoaded() ? 'yes' : 'no' }` );
}

function rotateKey() {
	const config = ensureConfigReady();
	if ( ! requiresApiKey( config.tunnelMode ) ) {
		console.log( 'Local-only mode does not require an API key; no key was rotated.' );
		console.log( `Config: ${ ENV_PATH }` );
		return;
	}

	const nextApiKey = randomBytes( 32 ).toString( 'hex' );
	const wasLoaded = process.platform === 'darwin' && isLoaded();

	writeConfig( {
		...config,
		apiKey: nextApiKey,
	} );

	console.log( 'Rotated SLOProxy API key.' );
	console.log( `Config: ${ ENV_PATH }` );
	console.log( `API Key: ${ nextApiKey }` );

	if ( process.platform !== 'darwin' ) {
		return;
	}

	if ( wasLoaded ) {
		console.log( '' );
		console.log( 'LaunchAgent is currently running; restarting it now.' );
		startService();
		return;
	}

	console.log( '' );
	console.log( 'LaunchAgent is not running; no restart was needed.' );
}

function main() {
	const action = process.argv[ 2 ] || 'status';

	switch ( action ) {
		case 'install':
			requireMacOs();
			installService();
			break;
		case 'start':
			requireMacOs();
			startService();
			break;
		case 'stop':
			requireMacOs();
			stopService();
			break;
		case 'status':
			requireMacOs();
			statusService();
			break;
		case 'rotate-key':
			rotateKey();
			break;
		case 'uninstall':
			requireMacOs();
			uninstallService();
			break;
		default:
			console.error( `Unknown LaunchAgent command: ${ action }` );
			process.exit( 1 );
	}
}

const IS_DIRECT_RUN = process.argv[ 1 ] && resolve( fileURLToPath( import.meta.url ) ) === resolve( process.argv[ 1 ] );

if ( IS_DIRECT_RUN ) {
	main();
}

export {
	ENV_PATH,
	LABEL,
	LOG_DIR,
	PLIST_PATH,
	SERVICE_TARGET,
	buildPlist,
	rotateKey,
};
