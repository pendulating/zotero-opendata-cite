/* global Zotero, Services, OpenDataCite, OpenDataProviders */
var OpenDataCite;
var OpenDataProviders;

function install() {}

async function startup({ id, version, rootURI }) {
	Zotero.debug(`OpenData Cite: starting ${version}`);

	Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + 'content/preferences.xhtml',
		label: 'OpenData Cite',
		image: rootURI + 'content/icons/dataset.svg',
	});

	Services.scriptloader.loadSubScript(rootURI + 'content/providers.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/opendata-cite.js');
	OpenDataCite.init({ id, version, rootURI });
	OpenDataCite.addToAllWindows();

	// Handy for the Run JavaScript window and for tests
	Zotero.OpenDataCite = OpenDataCite;
}

function onMainWindowLoad({ window }) {
	OpenDataCite.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	OpenDataCite.removeFromWindow(window);
}

function shutdown() {
	Zotero.debug('OpenData Cite: shutting down');
	OpenDataCite.unregisterMenus();
	OpenDataCite.removeFromAllWindows();
	delete Zotero.OpenDataCite;
	OpenDataCite = undefined;
	OpenDataProviders = undefined;
}

function uninstall() {}
