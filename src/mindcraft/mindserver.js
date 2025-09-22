// src/mindcraft/mindserver.js
import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as mindcraft from './mindcraft.js';

// ESM dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * MindServer:
 * - central hub for communication between all agent processes
 * - API to control from other languages/remote users
 * - web app host (serves /public)
 */

let io;
let server;

// name -> AgentConnection
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(
    readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8')
);

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;          // socket.io connection to the AGENT PROCESS
        this.settings = settings;    // last-known settings applied to this agent
        this.in_game = false;        // whether the agent reports "logged in"
        this.full_state = null;      // optional cache from get-full-state
        this.viewer_port = viewer_port;
    }
    // Merge settings so partial updates don't blow away other fields
    setSettings(partial) {
        this.settings = { ...(this.settings || {}), ...(partial || {}) };
    }
}

/**
 * Called by mindcraft.js when an agent is created (before login).
 */
export function registerAgent(settings, viewer_port) {
    const name = settings?.profile?.name;
    const conn = new AgentConnection(settings, viewer_port);
    agent_connections[name] = conn;
}

/**
 * Called by mindcraft.js or agent process to mark agent logged-out.
 */
export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

/**
 * Start MindServer (Express + Socket.IO)
 */
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Proxy per-agent viewers: /viewer/:port -> http://localhost:PORT
    app.use('/viewer/:port', (req, res, next) => {
        const viewerPort = req.params.port;
        const targetUrl = `http://localhost:${viewerPort}`;

        const proxy = createProxyMiddleware({
            target: targetUrl,
            changeOrigin: true,
            pathRewrite: {
                [`^/viewer/${viewerPort}`]: '' // strip the /viewer/PORT prefix
            },
            ws: true,
            logLevel: 'warn',
            onError: (err, _req, res2) => {
                // Avoid throwing; respond with a helpful 502
                console.error(`Viewer proxy error for port ${viewerPort}:`, err.message);
                res2.status(502).send(`Viewer on port ${viewerPort} is not available`);
            }
        });

        proxy(req, res, next);
    });

    // Serve web UI
    app.use(express.static(path.join(__dirname, 'public')));

    // Socket.IO connection handling
    io.on('connection', (socket) => {
        let curAgentName = null; // if this socket belongs to an agent process

        // Send initial status to this client
        agentsStatusUpdate(socket);

        /**
         * Create a new agent (from UI/API)
         */
        socket.on('create-agent', async (settings, callback) => {
            try {
                // Fill defaults & validate
                for (let key in settings_spec) {
                    if (!(key in settings)) {
                        if (settings_spec[key].required) {
                            callback?.({ success: false, error: `Setting ${key} is required` });
                            return;
                        } else {
                            settings[key] = settings_spec[key].default;
                        }
                    }
                }
                // Remove unknown keys
                for (let key in settings) {
                    if (!(key in settings_spec)) {
                        delete settings[key];
                    }
                }

                // Default the SECOND agent to human-controlled if not provided
                if (Object.keys(agent_connections).length === 1) {
                    settings.human_controllable = true;
                }


                const name = settings?.profile?.name;
                if (!name) {
                    callback?.({ success: false, error: 'Agent name is required in profile' });
                    return;
                }
                if (name in agent_connections) {
                    callback?.({ success: false, error: 'Agent already exists' });
                    return;
                }

                // Create via mindcraft (spawns process, etc.)
                const returned = await mindcraft.createAgent(settings);
                callback?.({ success: returned.success, error: returned.error });

                if (!returned.success && agent_connections[name]) {
                    // cleanup if partial
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }

                agentsStatusUpdate();
            } catch (err) {
                console.error('create-agent error:', err);
                callback?.({ success: false, error: String(err?.message ?? err) });
            }
        });

        /**
         * Return settings for an agent
         */
        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback?.({ settings: agent_connections[agentName].settings });
            } else {
                callback?.({ error: `Agent '${agentName}' not found.` });
            }
        });

        /**
         * Agent process announces it has a socket (pre-login)
         */
        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        /**
         * Agent process logs into the game
         */
        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            } else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        /**
         * Socket disconnect handling (agent process or UI)
         */
        socket.on('disconnect', () => {
            if (curAgentName && agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        /**
         * Agent-to-agent chat (legacy path)
         * Uses curAgentName as "from"
         */
        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json?.message}`);
            agent_connections[agentName].socket?.emit('chat-message', curAgentName, json);
        });

        /**
         * Update agent settings (merge) and restart the agent process
         */
        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                agentsStatusUpdate(); // reflect ASAP in UI
                agent.socket?.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName]?.socket?.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            setTimeout(() => {
                console.log('Exiting MindServer');
                process.exit(0);
            }, 2000);
        });

        /**
         * Web UI → Agent messaging
         * Gate messages when the target is human-controlled: only allow
         * channel === 'instruction' from 'UI'.
         */
        socket.on('send-message', (agentName, data) => {
            const target = agent_connections[agentName];
            if (!target) {
                console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
            }
            try {
                const isHuman = !!(target.settings && target.settings.human_controllable);
                if (isHuman && !(data?.channel === 'instruction' && data?.from === 'UI')) {
                    console.log(`Dropped non-instruction message to human-controlled agent ${agentName}`);
                    return;
                }
                target.socket?.emit('send-message', data);
            } catch (error) {
                console.error('Error forwarding send-message:', error);
            }
        });

        /**
         * Agent → UI log relay
         */
        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        /**
         * UI subscribes to periodic state snapshots
         */
        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    const host = host_public ? '0.0.0.0' : 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port}`);
    });

    return server;
}

/**
 * Emit current agents list to either one socket or all sockets (io)
 * Includes human_controllable so UI checkboxes render correctly.
 */
function agentsStatusUpdate(socket) {
    const out = socket || io;
    const agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName,
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
            human_controllable: !!(conn.settings && conn.settings.human_controllable)
        });
    }
    out.emit('agents-status', agents);
}

/**
 * Periodically gather full states from in-game agents for subscribed listeners.
 */
let listenerInterval = null;

function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                const agent = agent_connections[agentName];
                if (agent.in_game && agent.socket) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    const idx = agent_listeners.indexOf(listener_socket);
    if (idx >= 0) agent_listeners.splice(idx, 1);
    if (agent_listeners.length === 0 && listenerInterval) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional exports
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;
