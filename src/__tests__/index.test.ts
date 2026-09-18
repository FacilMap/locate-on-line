import { expect, test } from "vitest";
import handles from "./handles.json" with { type: "json" };
import track from "./track.json" with { type: "json" };
import expectedResult from "./result.json" with { type: "json" };
import { LineString } from "..";

const precision = 7;
const runs = 1;

const approximateExpectedResult = expectedResult.map((r) => ({
	idx: expect.closeTo(r.idx, precision),
	closest: {
		lat: expect.closeTo(r.closest.lat, precision),
		lng: expect.closeTo(r.closest.lng, precision)
	}
}))

test("locate", async () => {
	console.time("locate");
	const polyline = new LineString(track);
	for (let i = 0; i < runs; i++) {
		const res = polyline.locate(handles);
		if (i === 0) {
			expect(res).toEqual(approximateExpectedResult);
		}
	}
	console.timeEnd("locate");
});
