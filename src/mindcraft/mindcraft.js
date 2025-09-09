// src/mindcraft/mindcraft.js
import { createMindServer, registerAgent, numStateListeners } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import open from 'open';
import net from 'net';

let mindserver;
let connected = false;
let uiPort = 8080;                 // single source of truth for the MindServer UI port
const agent_processes = {};        // name -> AgentProcess
const agent_viewer_ports = new Map(); // name -> viewerPort
const reservedViewerPorts = new Set(); // reserved viewer ports to avoid races
let agent_count = 0;

// ---------- Port helpers ----------
function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.once('close', () => resolve(true)).close())
            .listen(port, '0.0.0.0');
    });
}

async function nextFreeViewerPort(start = 3000) {
    let p = start;
    while (reservedViewerPorts.has(p) || !(await isPortFree(p))) {
        p++;
    }
    reservedViewerPorts.add(p); // reserve immediately to prevent concurrent picks
    return p;
}
function releaseViewerPort(p) {
    reservedViewerPorts.delete(p);
}

// ---------- Name helper ----------
function uniqueAgentName(base) {
    let name = base;
    let i = 2;
    while (agent_processes[name]) name = `${base}_${i++}`;
    return name;
}

// ---------- Lifecycle ----------
export async function init(host_public = false, portArg = 8080, auto_open_ui = true) {
    if (connected) {
        console.error('Already initialized!');
        return;
    }
    mindserver = createMindServer(host_public, portArg);
    uiPort = portArg;               // <- set module-level UI port
    connected = true;

    if (auto_open_ui) {
        setTimeout(() => {
            if (numStateListeners() === 0) {
                open(`http://localhost:${uiPort}`);
            }
        }, 3000);
    }
}

export async function createAgent(settings) {
    if (!settings?.profile?.name) {
        const msg = 'Agent name is required in profile';
        console.error(msg);
        return { success: false, error: msg };
    }
    // Deep clone to avoid external mutation
    settings = JSON.parse(JSON.stringify(settings));

    // Ensure unique name locally to avoid UI/state overwrite
    settings.profile.name = uniqueAgentName(settings.profile.name);
    const agent_name = settings.profile.name;

    // Allocate & reserve a free viewer port (3000, 3001, ...)
    const viewer_port = await nextFreeViewerPort(3000);
    const viewer_offset = viewer_port - 3000;

    // Register with MindServer/UI before launching process
    registerAgent(settings, viewer_port);
    agent_viewer_ports.set(agent_name, viewer_port);
    console.log(`[Mindcraft] ${agent_name} -> viewer ${viewer_port} (offset ${viewer_offset})`);

    // Safe defaults
    const load_memory = settings.load_memory ?? false;
    const init_message = settings.init_message ?? null;

    // Optional: resolve Minecraft server automatically
    try {
        const server = await getServer(settings.host, settings.port, settings.minecraft_version);
        settings.host = server.host;
        settings.port = server.port;
        settings.minecraft_version = server.version;
    } catch (e) {
        console.warn(`getServer() failed; using provided host/port. ${e?.message ?? e}`);
    }

    try {
        // Pass the correct MindServer UI port to the agent process
        const agentProcess = new AgentProcess(agent_name, uiPort);
        agent_processes[agent_name] = agentProcess;

        // viewer_offset tells the bot which prismarine-viewer port to bind (3000 + offset)
        agentProcess.start(load_memory, init_message, viewer_offset);

        // Keep a monotonic counter around for any legacy assumptions
        agent_count = Math.max(agent_count, viewer_offset + 1);

        return { success: true, error: null, name: agent_name, viewer_port };
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        // Roll back registration/reservation so the next try can succeed
        destroyAgent(agent_name);
        return { success: false, error: error.message };
    }
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function startAgent(agentName) {
    const p = agent_processes[agentName];
    if (p) p.continue();
    else console.error(`Cannot start agent ${agentName}; not found`);
}

export function stopAgent(agentName) {
    const p = agent_processes[agentName];
    if (p) p.stop();
}

export function destroyAgent(agentName) {
    const p = agent_processes[agentName];
    if (p) {
        try { p.stop(); } catch { }
        delete agent_processes[agentName];
    }
    const vp = agent_viewer_ports.get(agentName);
    if (vp) {
        releaseViewerPort(vp);
        agent_viewer_ports.delete(agentName);
    }
}

export function shutdown() {
    console.log('Shutting down');
    for (const name in agent_processes) {
        try { agent_processes[name].stop(); } catch { }
    }
    setTimeout(() => process.exit(0), 2000);
}
