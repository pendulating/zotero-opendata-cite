/* global Zotero, Services, OpenDataProviders */

var OpenDataCite = {
	id: null,
	version: null,
	rootURI: null,
	menuIDs: [],
	_l10n: null,

	PREF_BRANCH: 'extensions.opendata-cite.',
	NOTE_HEADING: 'Dataset details:',

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.registerMenus();
	},

	log(msg) {
		Zotero.debug('OpenData Cite: ' + msg);
	},

	getPref(name) {
		return Zotero.Prefs.get(this.PREF_BRANCH + name, true);
	},

	get zoteroMajorVersion() {
		return parseInt(Zotero.version, 10);
	},

	// ---------------------------------------------------------------------
	// Localization
	// ---------------------------------------------------------------------

	getString(id, args) {
		if (!this._l10n) {
			let win = Zotero.getMainWindow();
			this._l10n = new win.Localization(['opendata-cite.ftl'], true);
		}
		return this._l10n.formatValueSync(id, args) || id;
	},

	// ---------------------------------------------------------------------
	// UI registration
	// ---------------------------------------------------------------------

	addToWindow(window) {
		window.MozXULElement.insertFTLIfNeeded('opendata-cite.ftl');
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.addToWindow(win);
		}
	},

	removeFromWindow(window) {
		window.document.querySelector('[href="opendata-cite.ftl"]')?.remove();
	},

	removeFromAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.removeFromWindow(win);
		}
	},

	registerMenus() {
		let icon = this.rootURI + 'content/icons/dataset.svg';
		this.menuIDs.push(Zotero.MenuManager.registerMenu({
			menuID: 'opendata-cite-file-add',
			pluginID: this.id,
			target: 'main/menubar/file',
			menus: [{
				menuType: 'menuitem',
				l10nID: 'opendata-cite-menu-add',
				icon,
				enableForTabTypes: ['library'],
				onCommand: (event, context) => {
					this.promptAndImport(Zotero.getMainWindow()).catch(e => Zotero.logError(e));
				},
			}],
		}));

		this.menuIDs.push(Zotero.MenuManager.registerMenu({
			menuID: 'opendata-cite-item-update',
			pluginID: this.id,
			target: 'main/library/item',
			menus: [{
				menuType: 'menuitem',
				l10nID: 'opendata-cite-menu-update',
				icon,
				onShowing: (event, context) => {
					context.setVisible(this.updatableItems(context.items).length > 0);
				},
				onCommand: (event, context) => {
					this.updateItems(this.updatableItems(context.items)).catch(e => Zotero.logError(e));
				},
			}],
		}));
	},

	unregisterMenus() {
		for (let menuID of this.menuIDs) {
			Zotero.MenuManager.unregisterMenu(menuID);
		}
		this.menuIDs = [];
	},

	// ---------------------------------------------------------------------
	// Network context handed to providers
	// ---------------------------------------------------------------------

	providerContext() {
		return {
			fetchJSON: async (url) => {
				let xhr = await Zotero.HTTP.request('GET', url, {
					headers: { Accept: 'application/json' },
					responseType: 'json',
					timeout: 30000,
				});
				return xhr.response;
			},
			fetchText: async (url) => {
				let xhr = await Zotero.HTTP.request('GET', url, { timeout: 30000 });
				return xhr.responseText;
			},
			prefs: {
				dateSource: this.getPref('dateSource') || 'dataUpdated',
				language: Zotero.locale,
			},
		};
	},

	// ---------------------------------------------------------------------
	// Import
	// ---------------------------------------------------------------------

	/** File → "Add Open Data Dataset…" */
	async promptAndImport(window) {
		let target = this.getSaveTarget(window);
		if (!target) {
			Services.prompt.alert(window,
				this.getString('opendata-cite-prompt-title'),
				this.getString('opendata-cite-error-read-only'));
			return;
		}

		let input = { value: this.urlsFromClipboard().join(' ') };
		let ok = Services.prompt.prompt(window,
			this.getString('opendata-cite-prompt-title'),
			this.getString('opendata-cite-prompt-text'),
			input, null, {});
		if (!ok) return;

		let urls = input.value.split(/\s+/).filter(Boolean);
		if (!urls.length) return;
		await this.importURLs(urls, target, window);
	},

	/** http(s) URLs on the clipboard that a provider recognizes, used to pre-fill the prompt */
	urlsFromClipboard() {
		try {
			let text = Zotero.Utilities.Internal.getClipboard('text/plain') || '';
			return text.split(/\s+/).filter(u => OpenDataProviders.canHandle(u));
		}
		catch (e) {
			return [];
		}
	},

	/** The library and collections currently selected in the main window, or null if read-only */
	getSaveTarget(window) {
		let pane = window.ZoteroPane;
		let libraryID;
		let collections;
		if (typeof pane.getSelectedLibraryIDs === 'function') {
			// Zotero 10+: multiple rows can be selected
			libraryID = pane.getSelectedLibraryIDs()[0];
			collections = pane.getSelectedCollections() || [];
		}
		else {
			libraryID = pane.getSelectedLibraryID();
			let collection = pane.getSelectedCollection();
			collections = collection ? [collection] : [];
		}
		if (!libraryID) libraryID = Zotero.Libraries.userLibraryID;
		if (!Zotero.Libraries.get(libraryID).editable) return null;
		return {
			libraryID,
			collectionIDs: collections.filter(c => c.libraryID === libraryID).map(c => c.id),
		};
	},

	async importURLs(urls, target, window) {
		let progress = new Zotero.ProgressWindow({ closeOnClick: true });
		progress.changeHeadline(this.getString('opendata-cite-progress-saving'));
		progress.show();

		let savedIDs = [];
		for (let url of urls) {
			let line = new progress.ItemProgress('dataset', url);
			line.setProgress(50);
			try {
				let result = await this.importURL(url, target);
				line.setText(result.existing
					? this.getString('opendata-cite-progress-exists', { title: result.item.getDisplayTitle() })
					: result.item.getDisplayTitle());
				line.setProgress(100);
				savedIDs.push(result.item.id);
			}
			catch (e) {
				Zotero.logError(e);
				line.setError();
				progress.addDescription(e.message || String(e));
			}
		}
		progress.startCloseTimer(savedIDs.length === urls.length ? 3000 : 8000);

		if (savedIDs.length && window && window.ZoteroPane) {
			await window.ZoteroPane.selectItems(savedIDs);
		}
		return savedIDs;
	},

	/**
	 * Fetch metadata for a dataset URL and save it into the target library.
	 * @return {Promise<{item: Zotero.Item, existing: boolean}>}
	 */
	async importURL(url, { libraryID, collectionIDs = [] }) {
		let record = await OpenDataProviders.resolve(url, this.providerContext());

		let existing = await this.findExisting(libraryID, record.url);
		if (existing) {
			return { item: existing, existing: true };
		}

		let item = new Zotero.Item('dataset');
		item.libraryID = libraryID;
		this.applyRecord(item, record);
		if (collectionIDs.length) item.setCollections(collectionIDs);
		await item.saveTx();

		if (record.noteHTML && this.getPref('createNote')) {
			let note = new Zotero.Item('note');
			note.libraryID = libraryID;
			note.parentID = item.id;
			note.setNote(record.noteHTML);
			await note.saveTx();
		}
		this.log(`Saved ${record.provider} dataset ${record.url} as item ${item.key}`);
		return { item, existing: false };
	},

	async findExisting(libraryID, url) {
		let search = new Zotero.Search();
		search.libraryID = libraryID;
		search.addCondition('itemType', 'is', 'dataset');
		search.addCondition('url', 'is', url);
		let ids = await search.search();
		let items = Zotero.Items.get(ids).filter(item => !item.deleted);
		return items[0] || null;
	},

	/** Copy a provider record onto a Zotero item (fields, creators, tags) */
	applyRecord(item, record) {
		let itemTypeID = item.itemTypeID;
		for (let [field, value] of Object.entries(record.fields)) {
			let fieldID = Zotero.ItemFields.getID(field);
			if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, itemTypeID)) {
				this.log(`Skipping field ${field} not valid for ${item.itemType}`);
				continue;
			}
			if (field === 'extra') {
				value = this.mergeExtra(item.getField('extra'), value);
			}
			item.setField(field, value || '');
		}
		item.setField('accessDate', Zotero.Date.dateToSQL(new Date(), true));

		item.setCreators(record.creators.map(c => ({
			lastName: c.name,
			firstName: '',
			fieldMode: 1,
			creatorType: c.creatorType,
		})));

		// Keep the user's own tags; replace only the automatic ones we manage
		let manualTags = item.getTags().filter(t => t.type !== 1);
		let autoTags = record.tags
			.filter(tag => !manualTags.some(t => t.tag === tag))
			.map(tag => ({ tag, type: 1 }));
		item.setTags([...manualTags, ...autoTags]);
	},

	/**
	 * Replace the "Key: value" lines this plugin manages in Extra, keeping
	 * everything else (notes, other plugins' lines) in place.
	 */
	mergeExtra(existing, managed) {
		let managedKeys = new Set(managed.split('\n').map(line => line.split(':')[0]));
		let ours = new Set(['Dataset ID', 'Platform', 'Formats', ...managedKeys]);
		let kept = (existing || '').split('\n')
			.filter(line => line.trim() && !ours.has(line.split(':')[0]));
		return [managed, ...kept].filter(Boolean).join('\n');
	},

	// ---------------------------------------------------------------------
	// Update existing items
	// ---------------------------------------------------------------------

	updatableItems(items) {
		return (items || []).filter(item => item.isRegularItem()
			&& OpenDataProviders.canHandle(item.getField('url')));
	},

	async updateItems(items) {
		let progress = new Zotero.ProgressWindow({ closeOnClick: true });
		progress.changeHeadline(this.getString('opendata-cite-progress-updating'));
		progress.show();

		let failures = 0;
		for (let item of items) {
			let line = new progress.ItemProgress(item.itemType, item.getDisplayTitle());
			line.setProgress(50);
			try {
				await this.updateItem(item);
				line.setText(item.getDisplayTitle());
				line.setProgress(100);
			}
			catch (e) {
				failures++;
				Zotero.logError(e);
				line.setError();
				progress.addDescription(e.message || String(e));
			}
		}
		progress.startCloseTimer(failures ? 8000 : 3000);
	},

	async updateItem(item) {
		let record = await OpenDataProviders.resolve(item.getField('url'), this.providerContext());
		if (item.itemType !== 'dataset') {
			item.setType(Zotero.ItemTypes.getID('dataset'));
		}
		this.applyRecord(item, record);

		let saveOptions = {};
		if (this.zoteroMajorVersion >= 10) {
			// Zotero 10 undo/redo
			saveOptions = { undoAction: 'undo-action-edit-metadata', undoActionArgs: { count: 1 } };
		}
		await item.saveTx(saveOptions);

		if (record.noteHTML && this.getPref('createNote')) {
			let note = Zotero.Items.get(item.getNotes())
				.find(n => n.getNoteTitle().startsWith(this.NOTE_HEADING));
			if (!note) {
				note = new Zotero.Item('note');
				note.libraryID = item.libraryID;
				note.parentID = item.id;
			}
			note.setNote(record.noteHTML);
			await note.saveTx();
		}
	},
};
