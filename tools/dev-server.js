#!/usr/bin/env node
/**
 * ComfyUI Workflow Studio - Decoupled Local Development Server
 * 
 * Runs Workflow Studio UI locally on Mac while connecting to a remote ComfyUI instance.
 * Allows instant live frontend development without restarting the remote ComfyUI backend.
 * 
 * Usage:
 *   yarn dev [--port 8000] [--comfy-url http://127.0.0.1:8188]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const STATIC_DIR = path.join(ROOT_DIR, "static");
const TEMPLATES_DIR = path.join(ROOT_DIR, "templates");

// Parse CLI arguments
const args = process.argv.slice(2);
let port = parseInt(process.env.PORT || "8000", 10);
let comfyUrl = process.env.COMFYUI_URL || "http://127.0.0.1:8188";

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[++i], 10);
    } else if (args[i] === "--comfy-url" && args[i + 1]) {
        comfyUrl = args[++i].replace(/\/+$/, "");
    }
}

// MIME types mapping
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf"
};

// Create reverse proxy for remote ComfyUI
const proxy = httpProxy.createProxyServer({
    target: comfyUrl,
    changeOrigin: true,
    ws: true,
    xfwd: true
});

// ComfyUI validates the `Origin` header on mutating requests and answers 403 with an empty
// body when it does not match its own host. `changeOrigin` only rewrites `Host`, so a page
// served from this bridge (`http://127.0.0.1:8000`) posting to a backend on `:8188` gets
// every write rejected — saving a workflow, metadata or a preset alike. Present the target's
// own origin, which is what a same-machine reverse proxy is.
proxy.on("proxyReq", (proxyReq, req) => {
    if (!req.headers.origin) return;
    try {
        proxyReq.setHeader("Origin", new URL(comfyUrl).origin);
    } catch {
        /* leave the header alone if the target URL is unparsable */
    }
});

proxy.on("error", (err, req, res) => {
    console.error(`❌ Proxy error forwarding to ${comfyUrl}:`, err.message);
    if (res && res.writeHead && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            error: "Failed to connect to remote ComfyUI backend",
            comfyUrl,
            details: err.message
        }));
    }
});

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    // 1. Root redirect to /wfm
    if (pathname === "/" || pathname === "/wfm/") {
        res.writeHead(302, { Location: "/wfm" });
        return res.end();
    }

    // 2. Main Studio Page
    if (pathname === "/wfm") {
        const indexPath = path.join(TEMPLATES_DIR, "index.html");
        fs.readFile(indexPath, "utf8", (err, data) => {
            if (err) {
                console.error("❌ Error reading index.html:", err);
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                return res.end("Error reading index.html: " + err.message);
            }
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache, no-store, must-revalidate"
            });
            res.end(data);
        });
        return;
    }

    // 3. Serve Static Files (/wfm_static/...)
    if (pathname.startsWith("/wfm_static/")) {
        const relPath = pathname.slice("/wfm_static/".length);
        const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, "");
        const filePath = path.join(STATIC_DIR, safeRel);

        if (!filePath.startsWith(STATIC_DIR)) {
            res.writeHead(403);
            return res.end("Forbidden");
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                return res.end("Not Found: " + pathname);
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || "application/octet-stream";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Cache-Control": "no-cache", // Always fresh during development
                "Content-Length": stats.size
            });

            const stream = fs.createReadStream(filePath);
            stream.pipe(res);
        });
        return;
    }

    // 4. Everything else (/api/wfm/*, /prompt, /system_stats, /object_info, /view, /history, etc.) -> Proxy to ComfyUI
    proxy.web(req, res, { target: comfyUrl });
});

// WebSocket proxy for ComfyUI execution progress & node state
server.on("upgrade", (req, socket, head) => {
    proxy.ws(req, socket, head, { target: comfyUrl });
});

server.listen(port, () => {
    console.log("\n=============================================================");
    console.log(" 🚀 ComfyUI Workflow Studio - Mac 本地独立开发服务已启动");
    console.log("=============================================================");
    console.log(` 📍 本地网页入口:  http://localhost:${port}/wfm`);
    console.log(` 🔗 远程算力节点:  ${comfyUrl}`);
    console.log(` 📂 本地静态目录:  ${STATIC_DIR}`);
    console.log(" ✨ 前端修改即刻生效，无需重启算力机 ComfyUI！");
    console.log("=============================================================\n");
});
