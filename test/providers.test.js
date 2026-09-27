const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require('../addon/content/providers.js');

const fixture = name => require(path.join(__dirname, 'fixtures', name));
const nycView = fixture('socrata-nyc-centerline.json');
const boston = fixture('ckan-boston-311.json');

/** ctx whose fetches are answered from a URL -> response map; unknown URLs 404 */
function fakeCtx(routes, prefs = {}) {
	let calls = [];
	let lookup = (url) => {
		calls.push(url);
		if (!(url in routes)) return Promise.reject(new Error(`404 ${url}`));
		return Promise.resolve(routes[url]);
	};
	return { fetchJSON: lookup, fetchText: lookup, prefs, calls };
}

beforeEach(() => P._clearCache());

test('socrata.match finds the 4x4 ID in common URL shapes', () => {
	for (let url of [
		'https://data.cityofnewyork.us/City-Government/Centerline/inkn-q76z/about_data',
		'https://data.cityofnewyork.us/d/inkn-q76z',
		'https://data.cityofnewyork.us/resource/inkn-q76z.json',
		'https://data.cityofnewyork.us/api/views/inkn-q76z',
	]) {
		let m = P.socrata.match(url);
		assert.equal(m.datasetID, 'inkn-q76z', url);
		assert.equal(m.origin, 'https://data.cityofnewyork.us');
	}
	assert.equal(P.socrata.match('https://example.com/about'), null);
	assert.equal(P.socrata.match('not a url'), null);
});

test('ckan.match handles path prefixes and locale segments', () => {
	let m = P.ckan.match('https://open.canada.ca/data/en/dataset/abc-123/resource/xyz');
	assert.equal(m.name, 'abc-123');
	assert.equal(m.pageBase, 'https://open.canada.ca/data/en');
	assert.deepEqual(m.apiBases, ['https://open.canada.ca/data/en', 'https://open.canada.ca/data']);
	assert.equal(P.ckan.match('https://data.boston.gov/about'), null);
});

test('Socrata: NYC Centerline maps to a dataset record', async () => {
	let origin = 'https://data.cityofnewyork.us';
	let ctx = fakeCtx({
		[`${origin}/api/views/inkn-q76z.json`]: nycView,
		[`${origin}/d/inkn-q76z`]: '<html><title>Centerline | NYC Open Data</title></html>',
		[`${origin}/resource/inkn-q76z.json?$select=count(*)`]: [{ count: '122311' }],
	});
	let r = await P.resolve(`${origin}/City-Government/Centerline/inkn-q76z/about_data`, ctx);
	assert.equal(r.provider, 'socrata');
	assert.equal(r.fields.title, 'Centerline');
	assert.equal(r.fields.extra, 'Dataset ID: inkn-q76z\nPlatform: Socrata');
	assert.equal(r.fields.identifier, undefined, 'identifier would render as "No. inkn-q76z"');
	assert.equal(r.fields.repository, 'NYC Open Data');
	assert.equal(r.fields.type, 'Geospatial dataset');
	assert.equal(r.fields.url, `${origin}/d/inkn-q76z`);
	assert.equal(r.fields.date, P.isoDate(nycView.rowsUpdatedAt));
	assert.match(r.fields.abstractNote, /NYC Street Centerline/);
	assert.deepEqual(r.creators, [{ name: 'Office of Technology and Innovation (OTI)', creatorType: 'author' }]);
	assert.deepEqual(r.tags, ['centerline', 'City Government']);
	assert.match(r.noteHTML, /122,311/);
	assert.match(r.noteHTML, /<code>physicalid<\/code>/);
	assert.match(r.noteHTML, /Update: Update Frequency<\/th><td>Weekly/);
});

test('Socrata: dateSource pref picks a different date', async () => {
	let origin = 'https://data.cityofnewyork.us';
	let ctx = fakeCtx({ [`${origin}/api/views/inkn-q76z.json`]: nycView }, { dateSource: 'created' });
	let r = await P.resolve(`${origin}/d/inkn-q76z`, ctx);
	assert.equal(r.fields.date, P.isoDate(nycView.createdAt));
	// Portal name falls back to the host when the page can't be fetched
	assert.equal(r.fields.repository, 'data.cityofnewyork.us');
});

test('CKAN: Boston 311 maps to a dataset record', async () => {
	let origin = 'https://data.boston.gov';
	let ctx = fakeCtx({
		[`${origin}/api/3/action/package_show?id=311-service-requests`]: boston,
		[`${origin}/api/3/action/status_show`]: { success: true, result: { site_title: 'Analyze Boston' } },
	});
	let r = await P.resolve(`${origin}/dataset/311-service-requests`, ctx);
	assert.equal(r.provider, 'ckan');
	assert.equal(r.fields.title, '311 Service Requests');
	assert.equal(r.fields.repository, 'Analyze Boston');
	assert.match(r.fields.extra, /^Dataset ID: 311-service-requests\nPlatform: CKAN\nFormats: .*CSV/);
	assert.equal(r.fields.format, undefined, 'format would replace APA\'s [Dataset]');
	assert.equal(r.fields.rights, boston.result.license_title);
	assert.deepEqual(r.creators, [{ name: 'Boston 311', creatorType: 'author' }]);
	assert.ok(r.tags.includes('311'));
	assert.match(r.noteHTML, /Resources \(\d+\)/);
});

test('A CKAN slug that looks like a Socrata ID falls through to CKAN', async () => {
	let origin = 'https://data.example.org';
	let pkg = { ...boston.result, name: 'road-2024', title: 'Roads 2024', title_translated: undefined };
	let ctx = fakeCtx({
		[`${origin}/api/3/action/package_show?id=road-2024`]: { success: true, result: pkg },
	});
	let r = await P.resolve(`${origin}/dataset/road-2024`, ctx);
	assert.equal(r.provider, 'ckan');
	assert.equal(r.fields.title, 'Roads 2024');
	assert.ok(ctx.calls.includes(`${origin}/api/views/road-2024.json`), 'Socrata was tried first');
});

test('resolve reports every provider error when nothing works', async () => {
	await assert.rejects(
		P.resolve('https://data.example.org/dataset/road-2024', fakeCtx({})),
		/Socrata: .*; CKAN: /
	);
	await assert.rejects(P.resolve('https://example.com/', fakeCtx({})), /Unrecognized/);
});

test('note HTML escapes portal-supplied text', () => {
	let view = { ...nycView, name: '<script>x</script>', columns: [] };
	let r = P.socrata.toRecord(view, { origin: 'https://h', portal: 'P', rowCount: null }, {});
	assert.ok(!r.noteHTML.includes('<script>'));
});

test('CKAN: bilingual portals use the preferred language', () => {
	let pkg = {
		name: 'x', title: 'Federal Corporations',
		title_translated: { en: 'Federal Corporations', fr: 'Sociétés de régime fédéral' },
		notes_translated: { en: 'English notes', fr: 'Notes françaises' },
		organization: { title: 'Industry Canada | Industrie Canada' },
		keywords: { en: ['companies'], fr: ['compagnies'] },
	};
	let meta = { pageBase: 'https://open.canada.ca/data/fr', portal: 'P' };
	let fr = P.ckan.toRecord(pkg, meta, { language: 'fr-CA' });
	assert.equal(fr.fields.title, 'Sociétés de régime fédéral');
	assert.equal(fr.fields.abstractNote, 'Notes françaises');
	assert.equal(fr.creators[0].name, 'Industrie Canada');
	assert.deepEqual(fr.tags, ['compagnies']);
	let en = P.ckan.toRecord(pkg, meta, {});
	assert.equal(en.creators[0].name, 'Industry Canada');
});

test('Socrata: HTML in descriptions becomes plain text', () => {
	let view = { ...nycView, description: '<strong>Note:</strong> a &amp; b<br>next' };
	let r = P.socrata.toRecord(view, { origin: 'https://h', portal: 'P', rowCount: null }, {});
	assert.equal(r.fields.abstractNote, 'Note: a & b\nnext');
});
