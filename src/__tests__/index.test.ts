import { expect, test } from "vitest";
import handles from "./handles.json" with { type: "json" };
import track from "./track.json" with { type: "json" };
import expectedResult from "./result.json" with { type: "json" };
import { JsPolyline1, JsPolyline2, JsPolyline3, KnnPolyline, locateOnLine, WasmPolyline } from "..";

const approximateExpectedResult = expectedResult.map((r) => ({
	idx: expect.closeTo(r.idx, 5),
	closest: {
		lat: expect.closeTo(r.closest.lat, 5),
		lng: expect.closeTo(r.closest.lng, 5)
	}
}))

const c = 20;

test("locateOnLine", async () => {
	console.time("wasm1");
	for (let i = 0; i < c; i++) {
		const polyline = new WasmPolyline(track);
		const res = polyline.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("wasm1");

	console.time("wasm2");
	const polyline = new WasmPolyline(track);
	for (let i = 0; i < c; i++) {
		const res = polyline.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("wasm2");
});

test("locateOnLine2", async () => {
	console.time("js1");
	for (let i = 0; i < c; i++) {
		const res = locateOnLine(track, handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js1");

	console.time("js2");
	const polyline1 = new JsPolyline1(track);
	for (let i = 0; i < c; i++) {
		const res = polyline1.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js2");

	console.time("js3");
	const polyline2 = new JsPolyline2(track);
	for (let i = 0; i < c; i++) {
		const res = polyline2.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js3");

	console.time("js4");
	const polyline3 = new JsPolyline3(track);
	for (let i = 0; i < c; i++) {
		const res = polyline3.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js4");
});

test("locateOnLine3", () => {
	console.time("knn");
	const polyline = new KnnPolyline(track);
	for (let i = 0; i < c; i++) {
		const res = polyline.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("knn");
});