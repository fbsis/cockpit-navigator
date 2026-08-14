const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);

export class GalleryManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.generation = 0;
		this.urls = new Set();
		this.missing = new Set();
		this.notice_signature = "";
	}

	extension(entry) {
		return entry.filename.includes(".") ? entry.filename.split(".").pop().toLowerCase() : "";
	}

	media_type(entry) {
		const extension = this.extension(entry);
		if (IMAGE_EXTENSIONS.has(extension)) return "image";
		if (VIDEO_EXTENSIONS.has(extension)) return "video";
		return null;
	}

	stop() {
		this.generation++;
		for (const url of this.urls) URL.revokeObjectURL(url);
		this.urls.clear();
	}

	async render(entries) {
		this.stop();
		const generation = this.generation;
		this.missing.clear();
		const media = entries.filter(entry => this.media_type(entry) && entry.visible);
		await Promise.all(Array.from({ length: Math.min(4, media.length) }, async (_, worker) => {
			for (let index = worker; index < media.length; index += 4)
				await this.render_entry(media[index], generation);
		}));
		if (generation === this.generation) this.show_dependency_notice();
	}

	async render_entry(entry, generation) {
		const type = this.media_type(entry);
		entry.dom_element.classList.add("nav-gallery-media");
		entry.dom_element.nav_item_icon.classList.add("nav-gallery-placeholder");
		try {
			const output = await cockpit.spawn(
				["/usr/share/cockpit/navigator/scripts/media-thumbnail.py3", type, entry.path_str()],
				{ superuser: "try", err: "message" },
			);
			if (generation !== this.generation) return;
			const result = JSON.parse(output);
			if (result.status === "missing") {
				this.missing.add(result.package);
				return;
			}
			if (result.status !== "ok") return;
			const contents = await cockpit.file(result.path, { binary: true, superuser: "try" }).read();
			if (generation !== this.generation || contents === null) return;
			const url = URL.createObjectURL(new Blob([contents], { type: "image/jpeg" }));
			this.urls.add(url);
			const image = document.createElement("img");
			image.className = "nav-gallery-thumbnail";
			image.alt = "";
			image.src = url;
			entry.dom_element.nav_item_icon.replaceChildren(image);
			if (type === "video") {
				const badge = document.createElement("i");
				badge.className = "fas fa-play nav-gallery-video-badge";
				entry.dom_element.nav_item_icon.appendChild(badge);
			}
		} catch (error) {
			console.warn(`Could not create thumbnail for ${entry.path_str()}`, error);
		}
	}

	show_dependency_notice() {
		if (!this.missing.size) return;
		const signature = [...this.missing].sort().join(",");
		if (signature === this.notice_signature) return;
		this.notice_signature = signature;
		const apt_packages = [...this.missing].join(" ");
		const dnf_packages = [...this.missing].map(name => name === "imagemagick" ? "ImageMagick" : name).join(" ");
		this.nav_window_ref.modal_prompt.alert(
			"Gallery thumbnails are unavailable",
			`Install the missing dependencies and reload Navigator:<br><br>` +
			`<code>sudo apt install ${apt_packages}</code><br>` +
			`or<br><code>sudo dnf install ${dnf_packages}</code><br><br>` +
			`Files remain available with their regular icons.`,
		);
	}
}
