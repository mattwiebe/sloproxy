import test from 'node:test';
import assert from 'node:assert/strict';

import { helpText, normalizeArgs, VERSION } from '../../bin/sloproxy.mjs';

test( 'normalizeArgs handles help and version flags locally', () => {
	assert.deepEqual( normalizeArgs( [ '--help' ] ), { action: 'help', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ '-h' ] ), { action: 'help', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ '--version' ] ), { action: 'version', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ '-v' ] ), { action: 'version', forwardedArgs: [] } );
} );

test( 'normalizeArgs maps commands to npm scripts', () => {
	assert.deepEqual( normalizeArgs( [ 'up' ] ), { action: 'script', script: 'up', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ 'up', '--port', '13531' ] ), { action: 'script', script: 'up', forwardedArgs: [ '--port', '13531' ] } );
	assert.deepEqual( normalizeArgs( [ 'init' ] ), { action: 'script', script: 'init', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ 'start' ] ), { action: 'script', script: 'start', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ 'rotate-key' ] ), { action: 'script', script: 'rotate-key', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ 'install' ] ), { action: 'script', script: 'service:install', forwardedArgs: [] } );
	assert.deepEqual( normalizeArgs( [ '--port', '13531' ] ), { action: 'script', script: 'up', forwardedArgs: [ '--port', '13531' ] } );
} );

test( 'helpText and version include the package version', () => {
	assert.match( helpText(), new RegExp( `sloproxy v${ VERSION.replace( /\./g, '\\.' ) }` ) );
	assert.match( helpText(), /sloproxy --version/ );
	assert.match( helpText(), /Alias for npm run up/ );
	assert.match( helpText(), /rotate-key/ );
	assert.match( helpText(), /--provider <slug:port>/ );
	assert.match( helpText(), /--tunnel <mode>/ );
} );
