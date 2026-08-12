/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 45Drives

	This file is part of Cockpit Navigator.
*/

export class NavigatorConfig {
	constructor() {
		this.script = "/usr/share/cockpit/navigator/scripts/config.py3";
		this.config = null;
	}

	async load() {
		if (this.config !== null)
			return this.config;

		const raw_config = await cockpit.spawn(
			[this.script, "read"],
			{ err: "out" }
		);
		const config = JSON.parse(raw_config || "{}");
		if (config === null || Array.isArray(config) || typeof config !== "object")
			throw new Error("Navigator configuration must be a JSON object.");
		this.config = config;
		return this.config;
	}

	async save() {
		if (this.config === null)
			throw new Error("Navigator configuration has not been loaded.");

		const process = cockpit.spawn(
			[this.script, "write"],
			{ err: "out" }
		);
		process.input(JSON.stringify(this.config, null, 2), true);
		await process;
	}
}
