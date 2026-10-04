import { checkMcp } from '../src/mcp/diagnostic.js';

console.log(`Node: ${process.version} (${process.execPath})`);
console.log(`Workspace: ${process.cwd()}`);
console.log('Checking local MCP initialization and tool discovery; no room tools will be called.');
const result = await checkMcp();
console.log(`${result.ok ? 'PASS' : 'FAIL'} [${result.phase}]: ${result.message}`);
if (result.exit) console.log(`Adapter exit: code=${result.exit.code}, signal=${result.exit.signal ?? 'none'}`);
if (result.stderr.trim()) console.log(`Adapter stderr (last 16 KiB):\n${result.stderr.trimEnd()}`);
if (!result.ok && !result.stderr.trim()) console.log('Adapter produced no stderr.');
process.exitCode = result.ok ? 0 : 1;
