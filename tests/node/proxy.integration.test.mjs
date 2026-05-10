import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath( new URL( '../..', import.meta.url ) );

function delay( ms ) {
	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );
}

async function listenOnLocalhost( server, port = 0 ) {
	await new Promise( ( resolve, reject ) => {
		server.once( 'error', reject );
		server.listen( port, '127.0.0.1', () => {
			server.off( 'error', reject );
			resolve();
		} );
	} );

	return server.address().port;
}

async function reservePort() {
	const server = createServer();
	const port = await listenOnLocalhost( server );
	await new Promise( ( resolve ) => server.close( resolve ) );
	return port;
}

async function closeServer( server ) {
	await new Promise( ( resolve ) => server.close( resolve ) );
}

async function readJsonBody( req ) {
	const chunks = [];
	for await ( const chunk of req ) {
		chunks.push( chunk );
	}

	return JSON.parse( Buffer.concat( chunks ).toString( 'utf8' ) || '{}' );
}

async function startFakeProvider( name, models ) {
	const requests = [];
	const server = createServer( async ( req, res ) => {
		requests.push( {
			method: req.method,
			url: req.url,
			authorization: req.headers.authorization ?? null,
		} );

		if ( 'GET' === req.method && '/v1/models' === req.url ) {
			res.writeHead( 200, { 'Content-Type': 'application/json' } );
			res.end( JSON.stringify( {
				object: 'list',
				data: models.map( ( id ) => ( {
					id,
					object: 'model',
					owned_by: name,
				} ) ),
			} ) );
			return;
		}

		if ( 'GET' === req.method && req.url.startsWith( '/v1/models/' ) ) {
			res.writeHead( 200, { 'Content-Type': 'application/json' } );
			res.end( JSON.stringify( {
				provider: name,
				model: decodeURIComponent( req.url.slice( '/v1/models/'.length ) ),
			} ) );
			return;
		}

		if ( 'POST' === req.method && '/v1/chat/completions' === req.url ) {
			const body = await readJsonBody( req );
			res.writeHead( 200, { 'Content-Type': 'application/json' } );
			res.end( JSON.stringify( {
				provider: name,
				model: body.model,
				authorization: req.headers.authorization ?? null,
			} ) );
			return;
		}

		res.writeHead( 404, { 'Content-Type': 'application/json' } );
		res.end( JSON.stringify( { error: 'not found' } ) );
	} );

	const port = await listenOnLocalhost( server );

	return {
		name,
		port,
		requests,
		close: () => closeServer( server ),
	};
}

function writeProxyEnv( path, { port, providers, tunnelMode = 'local', apiKey = '' } ) {
	writeFileSync(
		path,
		[
			'PORT="' + port + '"',
			'TUNNEL_MODE="' + tunnelMode + '"',
			'FUNNEL_PORT="8443"',
			'PROVIDERS="' + providers.join( ',' ) + '"',
			'BACKEND_URL=""',
			'API_KEY="' + apiKey + '"',
			'NO_TUNNEL="' + ( 'local' === tunnelMode ? '1' : '0' ) + '"',
			'',
		].join( '\n' ),
		'utf8'
	);
}

function startProxyProcess( envPath ) {
	const child = spawn( process.execPath, [ 'local/server.mjs' ], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			SLOPROXY_ENV_PATH: envPath,
		},
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} );
	let output = '';

	child.stdout.on( 'data', ( chunk ) => {
		output += chunk;
	} );
	child.stderr.on( 'data', ( chunk ) => {
		output += chunk;
	} );

	return {
		child,
		get output() {
			return output;
		},
	};
}

async function stopProxyProcess( proxy ) {
	if ( proxy.child.exitCode !== null || proxy.child.signalCode !== null ) {
		return;
	}

	const exit = new Promise( ( resolve ) => proxy.child.once( 'exit', resolve ) );
	proxy.child.kill( 'SIGINT' );
	if ( await Promise.race( [ exit.then( () => true ), delay( 1000 ).then( () => false ) ] ) ) {
		return;
	}

	proxy.child.kill( 'SIGKILL' );
	await exit;
}

async function waitForProxyReady( proxy, timeoutMs = 5000 ) {
	const started = Date.now();

	while ( Date.now() - started < timeoutMs ) {
		if ( proxy.output.includes( 'Listening on' ) ) {
			return;
		}

		if ( proxy.child.exitCode !== null ) {
			throw new Error( `Proxy exited before startup:\n${ proxy.output }` );
		}

		await delay( 50 );
	}

	throw new Error( `Proxy did not start:\n${ proxy.output }` );
}

async function waitForProxyExit( proxy, timeoutMs = 5000 ) {
	const exit = await Promise.race( [
		new Promise( ( resolve ) => proxy.child.once( 'exit', ( code, signal ) => resolve( { code, signal } ) ) ),
		delay( timeoutMs ).then( () => null ),
	] );

	if ( ! exit ) {
		await stopProxyProcess( proxy );
		throw new Error( `Proxy did not exit:\n${ proxy.output }` );
	}

	return exit;
}

async function fetchJson( url, options = {} ) {
	const response = await fetch( url, options );
	const body = await response.json();
	return { response, body };
}

async function waitForModels( proxyPort, expectedIds, timeoutMs = 7000 ) {
	const started = Date.now();
	let lastError = null;

	while ( Date.now() - started < timeoutMs ) {
		try {
			const { response, body } = await fetchJson( `http://127.0.0.1:${ proxyPort }/v1/models` );
			const ids = body?.data?.map( ( model ) => model.id ).sort() ?? [];
			if ( response.ok && JSON.stringify( ids ) === JSON.stringify( [ ...expectedIds ].sort() ) ) {
				return body;
			}
			lastError = new Error( `Unexpected models: ${ JSON.stringify( body ) }` );
		} catch ( error ) {
			lastError = error;
		}

		await delay( 100 );
	}

	throw lastError ?? new Error( 'Timed out waiting for models.' );
}

test( 'local proxy aggregates models and routes prefixed requests without auth', { timeout: 10000 }, async ( t ) => {
	const one = await startFakeProvider( 'one', [ 'alpha' ] );
	const two = await startFakeProvider( 'two', [ 'nested/beta' ] );
	const proxyPort = await reservePort();
	const envPath = join( mkdtempSync( join( tmpdir(), 'sloproxy-integration-' ) ), '.env' );
	writeProxyEnv( envPath, {
		port: proxyPort,
		providers: [ `one:${ one.port }`, `two:${ two.port }` ],
	} );
	const proxy = startProxyProcess( envPath );

	t.after( async () => {
		await stopProxyProcess( proxy );
		await one.close();
		await two.close();
	} );

	await waitForProxyReady( proxy );
	assert.match( proxy.output, /API Key\s+\(not required for local mode\)/ );
	assert.match( proxy.output, new RegExp( `Endpoint URL:\\s+http://127\\.0\\.0\\.1:${ proxyPort }` ) );
	assert.doesNotMatch( proxy.output, /<your-ip>/ );

	const models = await waitForModels( proxyPort, [ 'one/alpha', 'two/nested/beta' ] );
	assert.deepEqual( models.data.map( ( model ) => model.id ).sort(), [ 'one/alpha', 'two/nested/beta' ] );

	const routed = await fetchJson(
		`http://127.0.0.1:${ proxyPort }/v1/chat/completions`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { model: 'two/nested/beta', messages: [] } ),
		}
	);
	assert.equal( routed.response.status, 200 );
	assert.deepEqual( routed.body, {
		provider: 'two',
		model: 'nested/beta',
		authorization: null,
	} );

	const modelLookup = await fetchJson( `http://127.0.0.1:${ proxyPort }/v1/models/two%2Fnested%2Fbeta` );
	assert.equal( modelLookup.response.status, 200 );
	assert.deepEqual( modelLookup.body, {
		provider: 'two',
		model: 'nested/beta',
	} );

	const missingPrefix = await fetchJson(
		`http://127.0.0.1:${ proxyPort }/v1/chat/completions`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { model: 'alpha', messages: [] } ),
		}
	);
	assert.equal( missingPrefix.response.status, 400 );
	assert.match( missingPrefix.body.error, /provider prefix/ );
} );

test( 'proxy exits with a clear error for duplicate provider ports', { timeout: 10000 }, async () => {
	const providerPort = await reservePort();
	const proxyPort = await reservePort();
	const envPath = join( mkdtempSync( join( tmpdir(), 'sloproxy-duplicate-port-' ) ), '.env' );
	writeProxyEnv( envPath, {
		port: proxyPort,
		providers: [ `mlxstudio:${ providerPort }`, `vibeproxy:${ providerPort }` ],
	} );
	const proxy = startProxyProcess( envPath );
	const exit = await waitForProxyExit( proxy );

	assert.equal( exit.code, 1 );
	assert.match(
		proxy.output,
		new RegExp( `Duplicate provider port ${ providerPort } for "mlxstudio" and "vibeproxy"` )
	);
} );

test( 'proxy restarts when its env file changes', { timeout: 15000 }, async ( t ) => {
	const one = await startFakeProvider( 'one', [ 'alpha' ] );
	const two = await startFakeProvider( 'two', [ 'gamma' ] );
	const proxyPort = await reservePort();
	const envPath = join( mkdtempSync( join( tmpdir(), 'sloproxy-restart-' ) ), '.env' );
	writeProxyEnv( envPath, {
		port: proxyPort,
		providers: [ `one:${ one.port }` ],
	} );
	const proxy = startProxyProcess( envPath );

	t.after( async () => {
		await stopProxyProcess( proxy );
		await one.close();
		await two.close();
	} );

	await waitForProxyReady( proxy );
	await waitForModels( proxyPort, [ 'one/alpha' ] );

	// Startup output is printed before the main process registers watchFile().
	// Give the watcher one polling interval before changing the env file.
	await delay( 1200 );

	writeProxyEnv( envPath, {
		port: proxyPort,
		providers: [ `two:${ two.port }` ],
	} );

	await waitForModels( proxyPort, [ 'two/gamma' ], 12000 );
	assert.match( proxy.output, /changed; restarting proxy/ );
	assert.match( proxy.output, /Restart complete/ );
} );
