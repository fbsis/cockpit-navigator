/* Cockpit Navigator - Ace-based code editor. */

const DEFAULT_SETTINGS = {
	diffMode: "none",
	liveAutocompletion: true,
	fontSize: 14,
	softWrap: false,
	showLineNumbers: true,
	tabSize: 4,
	useSoftTabs: true,
	showFileProperties: false,
};

export class CodeEditor {
	constructor(config_store, callbacks = {}) {
		this.config_store = config_store;
		this.callbacks = callbacks;
		this.container = document.getElementById("nav-code-editor");
		this.settings_panel = document.getElementById("nav-editor-settings-panel");
		this.editor_view = document.getElementById("nav-edit-contents-view");
		this.info_column = document.getElementById("nav-info-column");
		this.info_spacer = document.getElementById("nav-info-spacer");
		this.sessions = new Map();
		this.active_path = null;
		this.editor = null;
		this.diff_view = null;
		this.save_timer = null;
		this.ready = this.initialize();
	}

	async initialize() {
		ace.config.set("basePath", "ace");
		ace.config.set("modePath", "ace");
		ace.config.set("themePath", "ace");
		ace.config.set("workerPath", "ace");
		this.settings = await this.config_store.section("editor", DEFAULT_SETTINGS);
		this.normalize_settings();
		this.build_editor();
		this.bind_settings();
		this.bind_layout_controls();
	}

	normalize_settings() {
		if (!["none", "inline", "split"].includes(this.settings.diffMode))
			this.settings.diffMode = DEFAULT_SETTINGS.diffMode;
		for (const key of ["liveAutocompletion", "softWrap", "showLineNumbers", "useSoftTabs", "showFileProperties"])
			this.settings[key] = typeof this.settings[key] === "boolean" ? this.settings[key] : DEFAULT_SETTINGS[key];
		this.settings.fontSize = this.clamp_number(this.settings.fontSize, 10, 32, DEFAULT_SETTINGS.fontSize);
		this.settings.tabSize = this.clamp_number(this.settings.tabSize, 1, 16, DEFAULT_SETTINGS.tabSize);
	}

	clamp_number(value, min, max, fallback) {
		const number = Number(value);
		return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
	}

	build_editor() {
		this.container.replaceChildren();
		const host = document.createElement("div");
		host.className = "nav-ace-pane";
		this.container.appendChild(host);
		this.editor = ace.edit(host);
		this.editor.setTheme("ace/theme/one_dark");
		this.editor.setOption("useWorker", false);
		this.apply_options(this.editor);
	}

	apply_options(editor) {
		editor.setTheme("ace/theme/one_dark");
		editor.setOptions({
			fontSize: `${this.settings.fontSize}px`,
			showGutter: this.settings.showLineNumbers,
			showLineNumbers: this.settings.showLineNumbers,
			enableBasicAutocompletion: true,
			enableLiveAutocompletion: this.settings.liveAutocompletion,
			enableSnippets: false,
			useWorker: false,
			showPrintMargin: false,
		});
		editor.session?.setUseWrapMode(this.settings.softWrap);
		editor.session?.setTabSize(this.settings.tabSize);
		editor.session?.setUseSoftTabs(this.settings.useSoftTabs);
	}

	bind_settings() {
		const fields = {
			diffMode: document.getElementById("nav-editor-diff-mode"),
			liveAutocompletion: document.getElementById("nav-editor-autocomplete"),
			fontSize: document.getElementById("nav-editor-font-size"),
			softWrap: document.getElementById("nav-editor-soft-wrap"),
			showLineNumbers: document.getElementById("nav-editor-line-numbers"),
			tabSize: document.getElementById("nav-editor-tab-size"),
			useSoftTabs: document.getElementById("nav-editor-soft-tabs"),
		};
		this.settings_fields = fields;
		for (const [key, field] of Object.entries(fields)) {
			field[field.type === "checkbox" ? "checked" : "value"] = this.settings[key];
			field.addEventListener("change", () => this.update_setting(key, field));
		}

		const button = document.getElementById("nav-editor-settings-btn");
		button.addEventListener("click", event => {
			event.stopPropagation();
			const open = this.settings_panel.style.display === "flex";
			this.settings_panel.style.display = open ? "none" : "flex";
			button.setAttribute("aria-expanded", String(!open));
		});
		document.documentElement.addEventListener("click", event => {
			if (!this.settings_panel.contains(event.target) && event.target !== button) {
				this.settings_panel.style.display = "none";
				button.setAttribute("aria-expanded", "false");
			}
		});
	}

	bind_layout_controls() {
		this.properties_button = document.getElementById("nav-editor-properties-btn");
		this.fullscreen_button = document.getElementById("nav-editor-fullscreen-btn");
		this.properties_button.addEventListener("click", () => {
			this.settings.showFileProperties = !this.settings.showFileProperties;
			this.apply_properties_visibility();
			this.schedule_save_settings();
		});
		this.fullscreen_button.addEventListener("click", () => this.toggle_fullscreen());
		window.addEventListener("keydown", event => {
			if (event.key === "Escape" && this.editor_view.classList.contains("nav-editor-fullscreen")) {
				event.preventDefault();
				this.set_fullscreen(false);
			}
		});
		this.properties_button.setAttribute("aria-pressed", String(this.settings.showFileProperties));
		this.properties_button.classList.toggle("pf-m-primary", this.settings.showFileProperties);
		this.properties_button.classList.toggle("pf-m-secondary", !this.settings.showFileProperties);
	}

	apply_properties_visibility() {
		const show = this.settings.showFileProperties && !this.editor_view.classList.contains("nav-editor-fullscreen");
		this.info_column.style.display = show ? "flex" : "none";
		this.info_spacer.style.display = show ? "block" : "none";
		this.properties_button.setAttribute("aria-pressed", String(this.settings.showFileProperties));
		this.properties_button.classList.toggle("pf-m-primary", this.settings.showFileProperties);
		this.properties_button.classList.toggle("pf-m-secondary", !this.settings.showFileProperties);
		this.resize();
	}

	toggle_fullscreen() {
		this.set_fullscreen(!this.editor_view.classList.contains("nav-editor-fullscreen"));
	}

	set_fullscreen(enabled) {
		this.editor_view.classList.toggle("nav-editor-fullscreen", enabled);
		this.fullscreen_button.setAttribute("aria-pressed", String(enabled));
		this.fullscreen_button.title = enabled ? "Exit fullscreen" : "Enter fullscreen";
		this.fullscreen_button.setAttribute("aria-label", this.fullscreen_button.title);
		const icon = this.fullscreen_button.querySelector("i");
		icon.classList.toggle("fa-expand", !enabled);
		icon.classList.toggle("fa-compress", enabled);
		this.apply_properties_visibility();
	}

	activate() {
		this.apply_properties_visibility();
		this.resize();
	}

	deactivate() {
		this.set_fullscreen(false);
		this.info_column.style.display = "flex";
		this.info_spacer.style.display = "block";
	}

	update_setting(key, field) {
		let value = field.type === "checkbox" ? field.checked : field.value;
		if (key === "fontSize")
			value = this.clamp_number(value, 10, 32, DEFAULT_SETTINGS.fontSize);
		if (key === "tabSize")
			value = this.clamp_number(value, 1, 16, DEFAULT_SETTINGS.tabSize);
		this.settings[key] = value;
		field[field.type === "checkbox" ? "checked" : "value"] = value;
		this.schedule_save_settings();
		if (key === "diffMode")
			this.show(this.active_path);
		else
			this.apply_to_visible_editors();
	}

	schedule_save_settings() {
		clearTimeout(this.save_timer);
		this.save_timer = setTimeout(async () => {
			try {
				await this.config_store.save();
			} catch (error) {
				this.callbacks.onError?.("Could not save editor settings.", error);
			}
		}, 350);
	}

	create_session(path, contents, display_path = path) {
		if (this.sessions.has(path))
			return this.sessions.get(path);
		const session = ace.createEditSession(contents, this.mode_for(display_path, contents));
		session.setOption("useWorker", false);
		session.setUseWrapMode(this.settings.softWrap);
		session.setTabSize(this.settings.tabSize);
		session.setUseSoftTabs(this.settings.useSoftTabs);
		const model = { path, display_path, session, original_contents: contents, modified: false };
		session.on("change", () => {
			model.modified = session.getValue() !== model.original_contents;
			this.callbacks.onChange?.(path, model.modified);
		});
		this.sessions.set(path, model);
		return model;
	}

	mode_for(path, contents = "") {
		const name = path.split("/").pop().toLowerCase();
		if (name === "dockerfile" || name.startsWith("dockerfile.")) return "ace/mode/dockerfile";
		if (name === "nginx.conf" || path.includes("/nginx/")) return "ace/mode/nginx";
		if (name === "httpd.conf" || name === "apache2.conf" || path.includes("/apache2/")) return "ace/mode/apache_conf";
		if (name === ".env" || name.endsWith(".env")) return "ace/mode/properties";
		const extension = name.includes(".") ? name.split(".").pop() : "";
		const modes = {
			sh: "sh", bash: "sh", zsh: "sh", fish: "sh", py: "python",
			js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
			ts: "typescript", tsx: "typescript", json: "json", jsonc: "json5", json5: "json5",
			yml: "yaml", yaml: "yaml", html: "html", htm: "html", css: "css", scss: "css",
			php: "php", sql: "sql", xml: "xml", svg: "xml", ini: "ini", cfg: "ini",
			conf: "ini", properties: "properties",
		};
		if (modes[extension]) return `ace/mode/${modes[extension]}`;
		if (/^#!.*\b(bash|sh|zsh|fish)\b/.test(contents)) return "ace/mode/sh";
		if (/^#!.*\bpython[0-9.]*\b/.test(contents)) return "ace/mode/python";
		return "ace/mode/text";
	}

	show(path) {
		if (!path || !this.sessions.has(path))
			return;
		this.active_path = path;
		this.destroy_diff_view();
		const model = this.sessions.get(path);
		if (this.settings.diffMode === "none") {
			if (!this.editor)
				this.build_editor();
			else if (!this.editor.container.isConnected) {
				this.container.replaceChildren(this.editor.container);
			}
			this.editor.setSession(model.session);
			this.apply_options(this.editor);
			this.editor.resize(true);
			this.editor.focus();
			return;
		}
		this.show_diff(model);
	}

	show_diff(model) {
		this.editor?.container.remove();
		const diff = ace.require("ace/ext/diff");
		const original = ace.createEditSession(model.original_contents, model.session.getMode().$id);
		original.setOption("useWorker", false);
		const diff_model = { sessionA: original, sessionB: model.session };
		if (this.settings.diffMode === "inline")
			diff_model.inline = "b";
		this.diff_view = diff.createDiffView(diff_model, { theme: "ace/theme/one_dark" });
		this.diff_view.editorA.setReadOnly(true);
		this.apply_options(this.diff_view.editorA);
		this.apply_options(this.diff_view.editorB);
		this.diff_view.editorA.setReadOnly(true);
		this.container.replaceChildren();
		if (this.settings.diffMode === "split") {
			this.diff_view.editorA.container.classList.add("nav-ace-pane", "nav-diff-pane");
			this.diff_view.editorB.container.classList.add("nav-ace-pane", "nav-diff-pane");
			this.container.append(this.diff_view.editorA.container, this.diff_view.editorB.container);
		} else {
			this.diff_view.activeEditor.container.classList.add("nav-ace-pane");
			this.container.appendChild(this.diff_view.activeEditor.container);
		}
		this.diff_view.onInput();
		this.diff_view.resize(true);
		this.diff_view.editorB.focus();
	}

	destroy_diff_view() {
		if (!this.diff_view)
			return;
		const modified_session = this.sessions.get(this.active_path)?.session;
		const selection = modified_session?.selection.getRange().clone();
		const backwards = modified_session?.selection.isBackwards();
		const original_session = this.diff_view.sessionA;
		const containers = [this.diff_view.editorA?.container, this.diff_view.editorB?.container];
		this.diff_view.destroy();
		original_session?.destroy?.();
		for (const container of containers)
			container?.remove();
		if (selection)
			modified_session.selection.setSelectionRange(selection, backwards);
		this.diff_view = null;
	}

	apply_to_visible_editors() {
		for (const model of this.sessions.values()) {
			model.session.setUseWrapMode(this.settings.softWrap);
			model.session.setTabSize(this.settings.tabSize);
			model.session.setUseSoftTabs(this.settings.useSoftTabs);
		}
		if (this.settings.diffMode === "none")
			this.apply_options(this.editor);
		else if (this.diff_view) {
			this.apply_options(this.diff_view.editorA);
			this.apply_options(this.diff_view.editorB);
			this.diff_view.editorA.setReadOnly(true);
			this.diff_view.resize(true);
		}
	}

	get_value(path) { return this.sessions.get(path)?.session.getValue(); }
	is_modified(path) { return Boolean(this.sessions.get(path)?.modified); }
	mark_saved(path) {
		const model = this.sessions.get(path);
		if (!model) return;
		model.original_contents = model.session.getValue();
		model.modified = false;
		this.callbacks.onChange?.(path, false);
		if (path === this.active_path && this.settings.diffMode !== "none")
			this.show(path);
	}
	destroy_session(path) {
		if (path === this.active_path) this.destroy_diff_view();
		this.sessions.get(path)?.session.destroy?.();
		this.sessions.delete(path);
	}
	resize() {
		if (this.diff_view) this.diff_view.resize(true);
		else this.editor?.resize(true);
	}
}
