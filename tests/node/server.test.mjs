import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildLocalhostBackendUrl,
	buildPublicUrl,
	formatRequestLogMessage,
	FUNNEL_PORT_CHOICES,
	getProviderConfigError,
	hasUsableConfig,
	getRequestSource,
	parseBooleanEnv,
	parseEnvFile,
	parseNumberOrFallback,
	parsePortNumber,
	parseProviderSpecifier,
	parseProvidersEnv,
	WORDPRESS_PLUGIN_RELEASES_URL,
	requiresApiKey,
	TUNNEL_MODES,
} from '../../local/server.mjs';

test( 'parseEnvFile parses quoted values and ignores comments', () => {
	const env = parseEnvFile( `
# Comment
PORT="13531"
BACKEND_URL='http://localhost:11434'
NO_TUNNEL=1
` );

	assert.deepEqual( env, {
		PORT: '13531',
		BACKEND_URL: 'http://localhost:11434',
		NO_TUNNEL: '1',
	} );
} );

test( 'buildPublicUrl omits port 443 and includes non-default public ports', () => {
	assert.equal( buildPublicUrl( 'wiebook.tail7a347e.ts.net', 443 ), 'https://wiebook.tail7a347e.ts.net' );
	assert.equal( buildPublicUrl( 'wiebook.tail7a347e.ts.net', 8443 ), 'https://wiebook.tail7a347e.ts.net:8443' );
} );

test( 'default funnel choice is 8443', () => {
	assert.equal( FUNNEL_PORT_CHOICES[0].port, 8443 );
	assert.equal( FUNNEL_PORT_CHOICES[0].label, '8443 (default)' );
} );

test( 'hasUsableConfig requires providers and only requires API key for tunneled modes', () => {
	assert.equal( hasUsableConfig( { backendUrl: 'http://localhost:11434', apiKey: 'secret' } ), true );
	assert.equal( hasUsableConfig( { backendUrl: '', apiKey: 'secret' } ), false );
	assert.equal( hasUsableConfig( { backendUrl: 'http://localhost:11434', apiKey: '' } ), false );
	assert.equal( hasUsableConfig( { providers: [ { slug: 'ollama', port: 11434, url: 'http://localhost:11434' } ], apiKey: 'secret' } ), true );
	assert.equal( hasUsableConfig( { providers: [ { slug: 'ollama', port: 11434, url: 'http://localhost:11434' } ], tunnelMode: 'local', apiKey: '' } ), true );
	assert.equal( hasUsableConfig( { providers: [ { slug: 'ollama', port: 11434, url: 'http://localhost:11434' } ], tunnelMode: 'cloudflare', apiKey: '' } ), false );
} );

test( 'parseBooleanEnv and parseNumberOrFallback normalize persisted values', () => {
	assert.equal( parseBooleanEnv( '1' ), true );
	assert.equal( parseBooleanEnv( 'true' ), true );
	assert.equal( parseBooleanEnv( '0' ), false );
	assert.equal( parseNumberOrFallback( '13531', 1 ), 13531 );
	assert.equal( parseNumberOrFallback( 'not-a-number', 8443 ), 8443 );
} );

test( 'parsePortNumber validates TCP port numbers', () => {
	assert.equal( parsePortNumber( '1234' ), 1234 );
	assert.equal( parsePortNumber( ' 8080 ' ), 8080 );
	assert.equal( parsePortNumber( '0' ), null );
	assert.equal( parsePortNumber( '65536' ), null );
	assert.equal( parsePortNumber( '1234.5' ), null );
	assert.equal( parsePortNumber( '1e3' ), null );
	assert.equal( parsePortNumber( 'not-a-port' ), null );
} );

test( 'buildLocalhostBackendUrl creates backend URL from a port', () => {
	assert.equal( buildLocalhostBackendUrl( '1234' ), 'http://localhost:1234' );
	assert.equal( buildLocalhostBackendUrl( 'not-a-port' ), '' );
} );

test( 'parseProviderSpecifier validates slug and port provider entries', () => {
	assert.deepEqual( parseProviderSpecifier( 'ollama:11434' ), {
		slug: 'ollama',
		port: 11434,
		url: 'http://localhost:11434',
	} );
	assert.deepEqual( parseProviderSpecifier( 'VibeProxy=3434' ), {
		slug: 'vibeproxy',
		port: 3434,
		url: 'http://localhost:3434',
	} );
	assert.equal( parseProviderSpecifier( 'bad slug:1234' ), null );
	assert.equal( parseProviderSpecifier( 'ollama:99999' ), null );
} );

test( 'parseProvidersEnv parses comma separated provider config', () => {
	assert.deepEqual( parseProvidersEnv( 'ollama:11434,lmstudio:1234' ), [
		{
			slug: 'ollama',
			port: 11434,
			url: 'http://localhost:11434',
		},
		{
			slug: 'lmstudio',
			port: 1234,
			url: 'http://localhost:1234',
		},
	] );
} );

test( 'provider config reports duplicate provider ports', () => {
	const providers = parseProvidersEnv( 'mlxstudio:8317,vibeproxy:8317' );

	assert.deepEqual( providers, [
		{
			slug: 'mlxstudio',
			port: 8317,
			url: 'http://localhost:8317',
		},
		{
			slug: 'vibeproxy',
			port: 8317,
			url: 'http://localhost:8317',
		},
	] );
	assert.equal(
		getProviderConfigError( providers ),
		'Duplicate provider port 8317 for "mlxstudio" and "vibeproxy". Each provider needs a unique localhost port.'
	);
} );

test( 'tunnel modes include local, tailscale, and cloudflare', () => {
	assert.deepEqual( TUNNEL_MODES, [ 'local', 'tailscale', 'cloudflare' ] );
	assert.equal( requiresApiKey( 'local' ), false );
	assert.equal( requiresApiKey( 'tailscale' ), true );
	assert.equal( requiresApiKey( 'cloudflare' ), true );
} );

test( 'getRequestSource prefers forwarded headers and includes host context', () => {
	const req = {
		headers: {
			'x-forwarded-for': '203.0.113.10, 10.0.0.1',
			origin: 'https://example.com',
		},
		socket: {
			remoteAddress: '::ffff:127.0.0.1',
		},
	};

	assert.equal( getRequestSource( req ), 'example.com (203.0.113.10)' );
} );

test( 'formatRequestLogMessage includes status, method, path, and source', () => {
	const req = {
		method: 'POST',
		url: '/v1/chat/completions',
		headers: {
			host: 'wiebook.tail7a347e.ts.net:8443',
		},
		socket: {
			remoteAddress: '::ffff:198.51.100.25',
		},
	};

	const message = formatRequestLogMessage( req, 200 );

	assert.match( message, /\] 200 POST \/v1\/chat\/completions from wiebook\.tail7a347e\.ts\.net:8443 \(198\.51\.100\.25\)$/ );
} );

test( 'WordPress plugin releases URL points to the GitHub latest release page', () => {
	assert.equal( WORDPRESS_PLUGIN_RELEASES_URL, 'https://github.com/mattwiebe/ai-connector-for-local-ai/releases/latest' );
} );
