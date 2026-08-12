export class TerminalManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.view = document.getElementById("nav-terminal-view");
		this.title = document.getElementById("nav-terminal-title");
		this.host = document.getElementById("nav-terminal-host");
		this.sessions = new Map();
		this.active_id = null;
		this.resize_observer = new ResizeObserver(() => this.resize_active());
		this.resize_observer.observe(this.host);
	}

	create(tab) {
		const container = document.createElement("div");
		container.className = "nav-terminal-session";
		this.host.appendChild(container);
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: '"Liberation Mono", "DejaVu Sans Mono", monospace',
			fontSize: 14,
			allowProposedApi: false,
			theme: { background: "#0d1117", foreground: "#f0f0f0", cursor: "#ffffff" },
			scrollback: 5000,
		});
		const fit = new FitAddon.FitAddon();
		terminal.loadAddon(fit);
		terminal.open(container);
		const channel = cockpit.channel({
			payload: "stream",
			spawn: ["/bin/sh", "-lc", 'exec "${SHELL:-/bin/sh}" -l'],
			directory: tab.path,
			environ: ["TERM=xterm-256color", "COLORTERM=truecolor"],
			pty: true,
			superuser: "try",
		});
		const session = { tab, container, terminal, fit, channel, exited: false };
		this.sessions.set(tab.id, session);
		terminal.onData(data => channel.send(data));
		terminal.onResize(({ rows, cols }) => {
			try { channel.control({ command: "window-change", rows, cols }); } catch (_) { /* already closed */ }
		});
		channel.addEventListener("message", (_event, data) => terminal.write(data));
		channel.addEventListener("close", () => {
			session.exited = true;
			if (this.sessions.has(tab.id))
				terminal.write("\r\n\x1b[90m[Terminal session ended]\x1b[0m\r\n");
		});
		return session;
	}

	show(tab) {
		this.active_id = tab.id;
		this.title.textContent = tab.path;
		for (const session of this.sessions.values())
			session.container.style.display = session.tab.id === tab.id ? "block" : "none";
		const session = this.sessions.get(tab.id) || this.create(tab);
		session.container.style.display = "block";
		requestAnimationFrame(() => {
			this.resize_active();
			session.terminal.focus();
		});
	}

	hide() {
		this.active_id = null;
		this.view.style.display = "none";
	}

	resize_active() {
		const session = this.sessions.get(this.active_id);
		if (!session || !this.host.isConnected || this.view.style.display === "none") return;
		try { session.fit.fit(); } catch (_) { /* hidden or closing */ }
	}

	destroy(tab_id) {
		const session = this.sessions.get(tab_id);
		if (!session) return;
		if (!session.exited) {
			session.exited = true;
			session.channel.close("terminated");
		}
		session.terminal.dispose();
		session.container.remove();
		this.sessions.delete(tab_id);
		if (this.active_id === tab_id) this.active_id = null;
	}
}
