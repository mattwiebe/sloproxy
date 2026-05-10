#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN_DIR = dirname( fileURLToPath( import.meta.url ) );
const ROOT_DIR = dirname( BIN_DIR );
const CONFIG_PATH = join( homedir(), '.config', 'sloproxy', '.env' );
const PACKAGE_JSON_PATH = join( ROOT_DIR, 'package.json' );
const PACKAGE_JSON = JSON.parse( readFileSync( PACKAGE_JSON_PATH, 'utf8' ) );
const VERSION = PACKAGE_JSON.version;
const SCRIPT_MAP = {
	up: 'up',
	init: 'init',
	start: 'start',
	stop: 'stop',
	status: 'status',
	'rotate-key': 'rotate-key',
	install: 'service:install',
	uninstall: 'service:uninstall',
};

function normalizeArgs( rawArgs ) {
	if ( rawArgs.length === 0 ) {
		return { action: 'script', script: 'up', forwardedArgs: [] };
	}

	const first = rawArgs[0];

	if ( [ '--help', '-h', 'help' ].includes( first ) ) {
		return { action: 'help', forwardedArgs: [] };
	}

	if ( [ '--version', '-v', 'version' ].includes( first ) ) {
		return { action: 'version', forwardedArgs: [] };
	}

	if ( Object.hasOwn( SCRIPT_MAP, first ) ) {
		return {
			action: 'script',
			script: SCRIPT_MAP[ first ],
			forwardedArgs: [ ...rawArgs.slice( 1 ) ],
		};
	}

	if ( first.startsWith( '-' ) ) {
		return { action: 'script', script: 'up', forwardedArgs: rawArgs };
	}

	return { action: 'help', forwardedArgs: [] };
}

function helpText() {
	return `sloproxy v${ VERSION }

Usage:
  sloproxy up [options]
  sloproxy init [options]
  sloproxy install
  sloproxy start
  sloproxy stop
  sloproxy status
  sloproxy rotate-key
  sloproxy uninstall
  sloproxy --help
  sloproxy --version

Commands:
  up         Alias for npm run up
  init       Alias for npm run init
  install    Alias for npm run service:install
  start      Alias for npm run start
  stop       Alias for npm run stop
  status     Alias for npm run status
  rotate-key Alias for npm run rotate-key
  uninstall  Alias for npm run service:uninstall

Options:
  --port <n>              Local proxy port (default: 13531)
  --provider <slug:port>  Local provider; repeat for multiple providers
  --tunnel <mode>         local, tailscale, or cloudflare (default: local)
  --funnel-port <n>       Tailscale Funnel public port (default: 8443)
  --backend <url>         Legacy single-backend URL
  --api-key <key>         Shared API key for tunneled proxy modes
  --no-tunnel             Alias for --tunnel local
`;
}

function main() {
	const args = process.argv.slice( 2 );
	const normalized = normalizeArgs( args );

	if ( normalized.action === 'help' ) {
		console.log( helpText() );
		process.exit( 0 );
	}

	if ( normalized.action === 'version' ) {
		console.log( `sloproxy v${ VERSION }` );
		process.exit( 0 );
	}

	const child = spawn(
		'npm',
		[
			'run',
			'--silent',
			'--prefix',
			ROOT_DIR,
			normalized.script,
			'--',
			...normalized.forwardedArgs,
		],
		{
			stdio: 'inherit',
			env: {
				...process.env,
				SLOPROXY_ENV_PATH: process.env.SLOPROXY_ENV_PATH || CONFIG_PATH,
			},
		}
	);

	child.on( 'exit', ( code, signal ) => {
		if ( signal ) {
			process.kill( process.pid, signal );
			return;
		}

		process.exit( code ?? 0 );
	} );
}

const IS_DIRECT_RUN = process.argv[ 1 ] && realpathSync( fileURLToPath( import.meta.url ) ) === realpathSync( process.argv[ 1 ] );

if ( IS_DIRECT_RUN ) {
	main();
}

export {
	helpText,
	main,
	normalizeArgs,
	VERSION,
};
