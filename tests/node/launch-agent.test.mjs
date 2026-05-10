import test from 'node:test';
import assert from 'node:assert/strict';

import { ENV_PATH, LABEL, buildPlist } from '../../scripts/launch-agent.mjs';

test( 'buildPlist includes the LaunchAgent label and config env path', () => {
	const plist = buildPlist();

	assert.match( plist, new RegExp( LABEL ) );
	assert.match( plist, new RegExp( ENV_PATH.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) ) );
	assert.match( plist, /<key>RunAtLoad<\/key>\s*<true\/>/ );
	assert.match( plist, /<key>KeepAlive<\/key>\s*<true\/>/ );
	assert.match( plist, /sloproxy\.mjs/ );
	assert.match( plist, /Library\/Logs\/sloproxy\/stdout\.log/ );
} );
