export class TerminalManager {
	constructor(nav_window_ref, config_store) {
		this.nav_window_ref = nav_window_ref;
		this.config_store = config_store;
		this.view = document.getElementById("nav-terminal-view");
		this.title = document.getElementById("nav-terminal-title");
		this.host = document.getElementById("nav-terminal-host");
		this.command_button = document.getElementById("nav-terminal-commands-btn");
		this.command_menu = document.getElementById("nav-terminal-commands-menu");
		this.sessions = new Map();
		this.active_id = null;
		this.resize_observer = new ResizeObserver(() => this.resize_active());
		this.resize_observer.observe(this.host);
		this.command_button.addEventListener("click", event => {
			event.stopPropagation();
			this.toggle_commands().catch(error => this.show_command_error(error));
		});
		document.documentElement.addEventListener("click", event => {
			if (!this.command_menu.contains(event.target)) this.hide_commands();
		});
		window.addEventListener("keydown", event => {
			if (event.key === "Escape") this.hide_commands();
		});
	}

	async commands() {
		const terminal = await this.config_store.section("terminal", { commands: [] });
		if (!Array.isArray(terminal.commands)) terminal.commands = [];
		terminal.commands = terminal.commands.filter(item =>
			item && typeof item.name === "string" && typeof item.command === "string"
		);
		return terminal.commands;
	}

	async save_commands(commands) {
		const terminal = await this.config_store.section("terminal", { commands: [] });
		terminal.commands = commands;
		await this.config_store.save();
	}

	async add_command() {
		this.hide_commands();
		const response = await this.nav_window_ref.modal_prompt.prompt("Save terminal command", {
			name: { label: "Name:", type: "text" },
			command: { label: "Command:", type: "text" },
		});
		if (!response) return;
		const name = response.name.trim();
		const command = response.command.trim();
		if (!name || !command || /[\r\n]/.test(command)) {
			await this.nav_window_ref.modal_prompt.alert(
				"Invalid saved command",
				"Enter a name and a single-line command.",
			);
			return;
		}
		const commands = await this.commands();
		const existing = commands.find(item => item.name === name);
		if (existing) existing.command = command;
		else commands.push({ name, command });
		commands.sort((left, right) => left.name.localeCompare(right.name));
		await this.save_commands(commands);
	}

	execute_command(command) {
		this.hide_commands();
		const session = this.sessions.get(this.active_id);
		if (!session || session.exited) {
			this.nav_window_ref.modal_prompt.alert("Terminal session is not running.");
			return;
		}
		session.channel.send(command + "\r");
		session.terminal.focus();
	}

	async remove_command(command) {
		const commands = await this.commands();
		await this.save_commands(commands.filter(item => item.name !== command.name));
		await this.render_commands();
	}

	async render_commands() {
		this.command_menu.replaceChildren();
		const add = document.createElement("button");
		add.type = "button";
		add.className = "nav-terminal-command-add";
		add.innerHTML = '<i class="fas fa-plus"></i><span>Save command</span>';
		add.onclick = event => {
			event.stopPropagation();
			this.add_command().catch(error => this.show_command_error(error));
		};
		this.command_menu.appendChild(add);
		const commands = await this.commands();
		if (!commands.length) {
			const empty = document.createElement("div");
			empty.className = "nav-terminal-commands-empty";
			empty.textContent = "No saved commands";
			this.command_menu.appendChild(empty);
			return;
		}
		const separator = document.createElement("div");
		separator.className = "nav-terminal-command-separator";
		this.command_menu.appendChild(separator);
		for (const command of commands) {
			const item = document.createElement("div");
			item.className = "nav-terminal-command-item";
			const run = document.createElement("button");
			run.type = "button";
			run.className = "nav-terminal-command-run";
			run.title = command.command;
			run.innerHTML = '<i class="fas fa-play"></i>';
			const label = document.createElement("span");
			label.textContent = command.name;
			run.appendChild(label);
			run.onclick = event => {
				event.stopPropagation();
				this.execute_command(command.command);
			};
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "nav-terminal-command-remove";
			remove.title = `Remove ${command.name}`;
			remove.setAttribute("aria-label", `Remove ${command.name}`);
			remove.innerHTML = '<i class="fas fa-times"></i>';
			remove.onclick = event => {
				event.stopPropagation();
				this.remove_command(command).catch(error => this.show_command_error(error));
			};
			item.append(run, remove);
			this.command_menu.appendChild(item);
		}
	}

	async toggle_commands() {
		if (this.command_menu.style.display === "flex") return this.hide_commands();
		await this.render_commands();
		this.command_menu.style.display = "flex";
		this.command_button.setAttribute("aria-expanded", "true");
	}

	hide_commands() {
		this.command_menu.style.display = "none";
		this.command_button.setAttribute("aria-expanded", "false");
	}

	show_command_error(error) {
		this.hide_commands();
		this.nav_window_ref.modal_prompt.alert("Could not update saved commands.", error?.message || String(error));
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
		this.hide_commands();
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
