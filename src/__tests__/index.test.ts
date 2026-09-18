import { expect, test } from "vitest";
import handles from "./handles.json" with { type: "json" };
import track from "./track.json" with { type: "json" };
import expectedResult from "./result.json" with { type: "json" };
import { JsPolyline1, JsPolyline2, locateOnLine } from "..";

const approximateExpectedResult = expectedResult.map((r) => ({
	idx: expect.closeTo(r.idx, 5),
	closest: {
		lat: expect.closeTo(r.closest.lat, 5),
		lng: expect.closeTo(r.closest.lng, 5)
	}
}))

const c = 20;

test("locateOnLine2", async () => {
	console.time("js");
	for (let i = 0; i < c; i++) {
		const res = locateOnLine(track, handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js");

	console.time("js1");
	const polyline1 = new JsPolyline1(track);
	for (let i = 0; i < c; i++) {
		const res = polyline1.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js1");

	console.time("js2");
	const polyline2 = new JsPolyline2(track);
	for (let i = 0; i < c; i++) {
		const res = polyline2.locateOnLine(handles);
		// expect(res).toEqual(approximateExpectedResult);
	}
	console.timeEnd("js2");
});
