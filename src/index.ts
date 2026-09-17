import * as wasm from "../build/release.js";
import RBush from "rbush";
import knn from "rbush-knn";

export type LatLng = {
	lat: number;
	lng: number;
};

type Point = {
	x: number;
	y: number;
}

function isFlat(latlngs: LatLng[] | LatLng[][]): latlngs is LatLng[] {
	return !Array.isArray(latlngs[0]) || (typeof latlngs[0][0] !== 'object' && typeof latlngs[0][0] !== 'undefined');
}

const R = 6378137;
const d = 180 / Math.PI;

/**
 * Projects geographic coordinates into pixel coordinates.
 */
function project(latlng: LatLng): Point {
	const sin = Math.sin(latlng.lat / d);
	return {
		x: R * latlng.lng / d,
		y: R * Math.log((1 + sin) / (1 - sin)) / 2
	};
}

/**
 * Projects pixel coordinates into geographic coordinates.
 */
function unproject(point: Point): LatLng {
	return {
		lat: (2 * Math.atan(Math.exp(point.y / R)) - (Math.PI / 2)) * d,
		lng: point.x * d / R
	};
}

/**
 * Calculates the closest point to a point on a segment between two points.
 */
function closestPointOnSegment(point: Point, point1: Point, point2: Point): Point & { t: number } {
	const dx = point2.x - point1.x;
	const dy = point2.y - point1.y;
	const dot = dx * dx + dy * dy;
	const t = dot > 1 ? Math.max(0, Math.min(1, (((point.x - point1.x) * dx + (point.y - point1.y) * dy) / dot))) : 2;
	return {
		x: point1.x + dx * t,
		y: point1.y + dy * t,
		t
	};
}

function closestPointOnSegment2(point: Point, x1: number, y1: number, x2: number, y2: number, output: Point & { t: number }): void {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const dot = dx * dx + dy * dy;
	output.t = dot > 1 ? Math.max(0, Math.min(1, (((point.x - x1) * dx + (point.y - y1) * dy) / dot))) : 2;
	output.x = x1 + dx * output.t;
	output.y = y1 + dy * output.t;
}

/**
 * Returns the distance between two pixel coordinates.
 * @param sq If true, the sqaure of the distance is returned instead to save the calculation of the square root.
 */
function pointDistance(point1: Point, point2: Point, sq = false): number {
	const x = point2.x - point1.x;
	const y = point2.y - point1.y;
	const squareResult = x * x + y * y;
	return sq ? squareResult : Math.sqrt(squareResult);
}

const wasmCleanupRegistry = new FinalizationRegistry((ptr: number) => {
	wasm.__unpin(ptr);
});

type Idx<T extends LatLng[] | LatLng[][]> = T extends LatLng[][] ? [number, number] : number;

export class WasmPolyline<T extends LatLng[] | LatLng[][]> {

	readonly trackPointsPtr: number;
	readonly trackPointsView: Float64Array;

	readonly sectionOffsetsPtr: number;
	readonly sectionOffsetsView: Int32Array;

	readonly flat: boolean;

	constructor(trackPoints: T, isPolygon = false) {
		this.flat = isFlat(trackPoints);
		const normalizedTrackPoints = (this.flat ? [trackPoints] : trackPoints) as LatLng[][];

		if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
			throw new Error("Line doesn't have any track points.");
		}

		const trackPointsLength = 2 * normalizedTrackPoints.reduce((p, c) => p + c.length + (isPolygon ? 1 : 0), 0);
		this.trackPointsPtr = wasm.createF64Array(trackPointsLength);
		wasm.__pin(this.trackPointsPtr);
		wasmCleanupRegistry.register(this, this.trackPointsPtr);

		this.trackPointsView = new Float64Array(wasm.memory.buffer, this.trackPointsPtr, trackPointsLength);
		let i = 0;
		for (const points of normalizedTrackPoints) {
			for (const p of points) {
				const projected = project(p);
				this.trackPointsView[i++] = projected.x;
				this.trackPointsView[i++] = projected.y;
			}

			if (isPolygon && points.length > 0) {
				const projected = project(points[0]);
				this.trackPointsView[i++] = projected.x;
				this.trackPointsView[i++] = projected.y;
			}
		}

		const sectionOffsetsLength = Math.max(0, normalizedTrackPoints.length - 1);
		this.sectionOffsetsPtr = wasm.createI32Array(sectionOffsetsLength);
		wasm.__pin(this.sectionOffsetsPtr);
		wasmCleanupRegistry.register(this, this.sectionOffsetsPtr);

		this.sectionOffsetsView = new Int32Array(wasm.memory.buffer, this.sectionOffsetsPtr, sectionOffsetsLength);
		for (let offset = 0, i = 0; i < normalizedTrackPoints.length; i++) {
			if (i > 0) {
				this.sectionOffsetsView[i - 1] = offset;
			}
			offset += normalizedTrackPoints[i].length;
		}
	}

	/**
	 * Finds the closest position to the given point(s) on the given polyline.
	 * The position is given in the form of a fractional index. The index is a float somewhere between the integer index of point A
	 * of the matching segment and the integer index of point B of the matching segment.
	 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/Multipolygon.
	 * @param points The point or points to locate on the line.
	 * @param isPolygon If true, the line will be treated as a polygon, meaning that there is an additional segment between the last
	 *     and the first trackpoint (which can result in an index somewhere between trackPoints.length - 1 and trackPoints.length).
	 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
	 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
	 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
	 */
	locateOnLine(point: LatLng): { idx: Idx<T>; closest: LatLng };
	locateOnLine(points: LatLng[]): Array<{ idx: Idx<T>; closest: LatLng }>;
	locateOnLine(points: LatLng | LatLng[]): { idx: Idx<T>; closest: LatLng } | Array<{ idx: Idx<T>; closest: LatLng }> {
		const normalizedPoints = Array.isArray(points) ? points : [points];

		const rawResult = wasm.locateOnLine(this.trackPointsPtr, this.sectionOffsetsPtr, normalizedPoints.flatMap((p) => [p.lat, p.lng]));

		const result = new Array<{ idx: Idx<T>; closest: LatLng }>(rawResult.length / 4);
		for (let i = 0, j = 0; i < rawResult.length; i += 4, j++) {
			result[j] = {
				idx: (this.flat ? rawResult[i + 1] : [rawResult[i], rawResult[i + 1]]) as Idx<T>,
				closest: { lat: rawResult[i + 2], lng: rawResult[i + 3] }
			};
		}

		return Array.isArray(points) ? result : result[0];
	}
}

export class JsPolyline1<T extends LatLng[] | LatLng[][]> {

	readonly trackPoints: Point[][];
	readonly flat: boolean;

	constructor(trackPoints: T, isPolygon = false) {
		this.flat = isFlat(trackPoints);
		const normalizedTrackPoints = (this.flat ? [trackPoints] : trackPoints) as LatLng[][];

		if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
			throw new Error("Line doesn't have any track points.");
		}

		this.trackPoints = normalizedTrackPoints.map((t) => t.map((p) => project(p)));
	}

	/**
	 * Finds the closest position to the given point(s) on the given polyline.
	 * The position is given in the form of a fractional index. The index is a float somewhere between the integer index of point A
	 * of the matching segment and the integer index of point B of the matching segment.
	 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/Multipolygon.
	 * @param points The point or points to locate on the line.
	 * @param isPolygon If true, the line will be treated as a polygon, meaning that there is an additional segment between the last
	 *     and the first trackpoint (which can result in an index somewhere between trackPoints.length - 1 and trackPoints.length).
	 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
	 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
	 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
	 */
	locateOnLine(point: LatLng): { idx: Idx<T>; closest: LatLng };
	locateOnLine(points: LatLng[]): Array<{ idx: Idx<T>; closest: LatLng }>;
	locateOnLine(points: LatLng | LatLng[]): { idx: Idx<T>; closest: LatLng } | Array<{ idx: Idx<T>; closest: LatLng }> {
		const projectedPoints = (Array.isArray(points) ? points : [points]).map((point) => project(point));

		const data: Array<{ sqDist: number; idx: [number, number]; closest: Point }> = [];

		for (let i = 0; i < this.trackPoints.length; i++) {
			let pointA: Point;
			let pointB = this.trackPoints[i][0];
			for (let j = 1; j < this.trackPoints[i].length; j++) {
				pointA = pointB;
				pointB = this.trackPoints[i][j];

				for (let k = 0; k < projectedPoints.length; k++) {
					const point = projectedPoints[k];
					const closest = closestPointOnSegment(point, pointA, pointB);
					const sqDist = pointDistance(point, closest, true);
					if (data[k] == null || sqDist < data[k].sqDist) {
						data[k] = { sqDist, idx: [i, j - 1 + closest.t], closest };
					}
				}
			}
		}

		const results = data.map((d) => {
			return {
				idx: (this.flat ? d.idx[1] : d.idx) as Idx<T>,
				closest: unproject(d.closest)
			};
		});

		return Array.isArray(points) ? results : results[0];
	}
}

export class JsPolyline2<T extends LatLng[] | LatLng[][]> {

	readonly trackPoints: Float64Array;
	readonly sectionOffsets: number[];
	readonly flat: boolean;

	constructor(trackPoints: T, isPolygon = false) {
		this.flat = isFlat(trackPoints);
		const normalizedTrackPoints = (this.flat ? [trackPoints] : trackPoints) as LatLng[][];

		if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
			throw new Error("Line doesn't have any track points.");
		}

		const trackPointsLength = 2 * normalizedTrackPoints.reduce((p, c) => p + c.length + (isPolygon ? 1 : 0), 0);
		this.trackPoints = new Float64Array(trackPointsLength);
		let i = 0;
		for (const points of normalizedTrackPoints) {
			for (const p of points) {
				this.trackPoints[i++] = p.lat;
				this.trackPoints[i++] = p.lng;
			}

			if (isPolygon && points.length > 0) {
				this.trackPoints[i++] = points[0].lat;
				this.trackPoints[i++] = points[0].lng;
			}
		}

		this.sectionOffsets = normalizedTrackPoints.slice(1).map((t) => t.length);
	}

	/**
	 * Finds the closest position to the given point(s) on the given polyline.
	 * The position is given in the form of a fractional index. The index is a float somewhere between the integer index of point A
	 * of the matching segment and the integer index of point B of the matching segment.
	 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/Multipolygon.
	 * @param points The point or points to locate on the line.
	 * @param isPolygon If true, the line will be treated as a polygon, meaning that there is an additional segment between the last
	 *     and the first trackpoint (which can result in an index somewhere between trackPoints.length - 1 and trackPoints.length).
	 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
	 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
	 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
	 */
	locateOnLine(point: LatLng): { idx: Idx<T>; closest: LatLng };
	locateOnLine(points: LatLng[]): Array<{ idx: Idx<T>; closest: LatLng }>;
	locateOnLine(points: LatLng | LatLng[]): { idx: Idx<T>; closest: LatLng } | Array<{ idx: Idx<T>; closest: LatLng }> {
		const projectedPoints = (Array.isArray(points) ? points : [points]).map((point) => project(point));

		const data: Array<{ sqDist: number; idx: [number, number]; closest: Point }> = [];

		for (let i = -1; i < this.sectionOffsets.length; i++) {
			const start = i == -1 ? 0 : this.sectionOffsets[i];
			const end = i < this.sectionOffsets.length - 1 ? this.sectionOffsets[i + 1] : this.trackPoints.length;
			for (let j = start + 2; j < end; j += 2) {
				const pointA = { x: this.trackPoints[j - 2], y: this.trackPoints[j - 1] };
				const pointB = { x: this.trackPoints[j], y: this.trackPoints[j + 1] };

				for (let k = 0; k < projectedPoints.length; k++) {
					const point = projectedPoints[k];
					const closest = closestPointOnSegment(point, pointA, pointB);
					const sqDist = pointDistance(point, closest, true);
					if (data[k] == null || sqDist < data[k].sqDist) {
						data[k] = { sqDist, idx: [i, j - 1 + closest.t], closest };
					}
				}
			}
		}

		const results = data.map((d) => {
			return {
				idx: (this.flat ? d.idx[1] : d.idx) as Idx<T>,
				closest: unproject(d.closest)
			};
		});

		return Array.isArray(points) ? results : results[0];
	}
}


export class JsPolyline3<T extends LatLng[] | LatLng[][]> {

	readonly trackPoints: number[][];
	readonly flat: boolean;

	constructor(trackPoints: T, isPolygon = false) {
		this.flat = isFlat(trackPoints);
		const normalizedTrackPoints = (this.flat ? [trackPoints] : trackPoints) as LatLng[][];

		if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
			throw new Error("Line doesn't have any track points.");
		}

		this.trackPoints = normalizedTrackPoints.map((t) => [
			...t,
			...t.length > 0 && isPolygon ? [t[0]] : []
		].flatMap((p) => {
			const { x, y } = project(p);
			return [x, y];
		}));
	}

	/**
	 * Finds the closest position to the given point(s) on the given polyline.
	 * The position is given in the form of a fractional index. The index is a float somewhere between the integer index of point A
	 * of the matching segment and the integer index of point B of the matching segment.
	 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/Multipolygon.
	 * @param points The point or points to locate on the line.
	 * @param isPolygon If true, the line will be treated as a polygon, meaning that there is an additional segment between the last
	 *     and the first trackpoint (which can result in an index somewhere between trackPoints.length - 1 and trackPoints.length).
	 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
	 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
	 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
	 */
	locateOnLine(point: LatLng): { idx: Idx<T>; closest: LatLng };
	locateOnLine(points: LatLng[]): Array<{ idx: Idx<T>; closest: LatLng }>;
	locateOnLine(points: LatLng | LatLng[]): { idx: Idx<T>; closest: LatLng } | Array<{ idx: Idx<T>; closest: LatLng }> {
		const projectedPoints = (Array.isArray(points) ? points : [points]).map((point) => project(point));

		const data = projectedPoints.map(() => ({ sqDist: -1, idx1: 0, idx2: 0, x: 0, y: 0 }));
		const closest = { x: 0, y: 0, t: 0 };

		for (let i = 0; i < this.trackPoints.length; i++) {
			for (let j = 2; j < this.trackPoints[i].length; j += 2) {
				const x1 = this.trackPoints[i][j - 2];
				const y1 = this.trackPoints[i][j - 1];
				const x2 = this.trackPoints[i][j];
				const y2 = this.trackPoints[i][j + 1];

				for (let k = 0; k < projectedPoints.length; k++) {
					const point = projectedPoints[k];
					closestPointOnSegment2(point, x1, y1, x2, y2, closest);
					const sqDist = pointDistance(point, closest, true);
					if (data[k].sqDist === -1 || sqDist < data[k].sqDist) {
						data[k].sqDist = sqDist;
						data[k].idx1 = i;
						data[k].idx2 = j / 2 - 1 + closest.t;
						data[k].x = closest.x;
						data[k].y = closest.y;
					}
				}
			}
		}

		const results = data.map((d) => {
			return {
				idx: (this.flat ? d.idx2 : [d.idx1, d.idx2]) as Idx<T>,
				closest: unproject(d)
			};
		});

		return Array.isArray(points) ? results : results[0];
	}
}


type CustomTreeItem = {
	a: Point;
	b: Point;
	idxA: [number, number];
}

class CustomTree extends RBush<CustomTreeItem> {
	override toBBox({ a, b }: CustomTreeItem) {
		return {
			minX: Math.min(a.x, b.x),
			minY: Math.min(a.y, b.y),
			maxX: Math.max(a.x, b.x),
			maxY: Math.max(a.y, b.y)
		};
	}

    compareMinX({ a: a1, b: b1 }: CustomTreeItem, { a: a2, b: b2 }: CustomTreeItem) {
		return Math.min(a1.x, b1.x) - Math.min(a2.x, b2.x);
	}

    compareMinY({ a: a1, b: b1 }: CustomTreeItem, { a: a2, b: b2 }: CustomTreeItem) {
		return Math.min(a1.y, b1.y) - Math.min(a2.y, b2.y);
	}
}

export class KnnPolyline<T extends LatLng[] | LatLng[][]> {

	readonly tree: CustomTree;
	readonly flat: boolean;

	constructor(trackPoints: T, isPolygon = false) {
		this.flat = isFlat(trackPoints);
		const normalizedTrackPoints = (this.flat ? [trackPoints] : trackPoints) as LatLng[][];

		if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
			throw new Error("Line doesn't have any track points.");
		}

		this.tree = new CustomTree();
		for (let i = 0; i < normalizedTrackPoints.length; i++) {
			const projectedPoints = [
				...normalizedTrackPoints[i],
				...isPolygon && normalizedTrackPoints[i].length > 0 ? [normalizedTrackPoints[i][0]] : []
			].map((p) => project(p));

			for (let j = 1; j < projectedPoints.length; j++) {
				this.tree.insert({
					a: projectedPoints[j - 1],
					b: projectedPoints[j],
					idxA: [i, j - 1]
				});
			}
		}
	}

	/**
	 * Finds the closest position to the given point(s) on the given polyline.
	 * The position is given in the form of a fractional index. The index is a float somewhere between the integer index of point A
	 * of the matching segment and the integer index of point B of the matching segment.
	 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/Multipolygon.
	 * @param points The point or points to locate on the line.
	 * @param isPolygon If true, the line will be treated as a polygon, meaning that there is an additional segment between the last
	 *     and the first trackpoint (which can result in an index somewhere between trackPoints.length - 1 and trackPoints.length).
	 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
	 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
	 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
	 */
	locateOnLine(point: LatLng): { idx: Idx<T>; closest: LatLng };
	locateOnLine(points: LatLng[]): Array<{ idx: Idx<T>; closest: LatLng }>;
	locateOnLine(points: LatLng | LatLng[]): { idx: Idx<T>; closest: LatLng } | Array<{ idx: Idx<T>; closest: LatLng }> {
		const projectedPoints = (Array.isArray(points) ? points : [points]).map((point) => project(point));

		const data = new Array<{ sqDist: number; idx: [number, number]; closest: Point }>(projectedPoints.length);

		for (let i = 0; i < projectedPoints.length; i++) {
			const point = projectedPoints[i];

			const neighbours = knn(this.tree, point.x, point.y) as CustomTreeItem[];

			for (const { a, b, idxA } of neighbours) {
				const dx = Math.max(Math.min(a.x, b.x) - point.x, 0, point.x - Math.max(a.x, b.x));
				const dy = Math.max(Math.min(a.y, b.y) - point.y, 0, point.y - Math.max(a.y, b.y));
				const sqBoxDist = dx * dx + dy * dy;
				if (data[i] != null && sqBoxDist > data[i].sqDist) {
					break;
				}

				const closest = closestPointOnSegment(point, a, b);
				const sqDist = pointDistance(point, closest, true);
				if (data[i] == null || sqDist < data[i].sqDist) {
					data[i] = { sqDist, idx: [idxA[0], idxA[1] + closest.t], closest };
				}
			}
		}

		// for (let i = -1; i < this.sectionOffsets.length; i++) {
		// 	const start = i == -1 ? 0 : this.sectionOffsets[i];
		// 	const end = i < this.sectionOffsets.length - 1 ? this.sectionOffsets[i + 1] : this.trackPoints.length;
		// 	for (let j = start + 2; j < end; j += 2) {
		// 		const pointA = { x: this.trackPoints[j - 2], y: this.trackPoints[j - 1] };
		// 		const pointB = { x: this.trackPoints[j], y: this.trackPoints[j + 1] };

		// 		for (let k = 0; k < projectedPoints.length; k++) {
		// 			const point = projectedPoints[k];
		// 			const closest = closestPointOnSegment(point, pointA, pointB);
		// 			const sqDist = pointDistance(point, closest, true);
		// 			if (data[k] == null || sqDist < data[k].sqDist) {
		// 				data[k] = { sqDist, idx: [i, j - 1 + closest.t], closest };
		// 			}
		// 		}
		// 	}
		// }

		const results = data.map((d) => {
			return {
				idx: (this.flat ? d.idx[1] : d.idx) as Idx<T>,
				closest: unproject(d.closest)
			};
		});

		return Array.isArray(points) ? results : results[0];
	}
}

/**
 * Finds the closest position to the given point(s) on the given polyline.
 * The position is given in the form of a fractional index. The index is a float somewhere between the integer index of point A
 * of the matching segment and the integer index of point B of the matching segment.
 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/Multipolygon.
 * @param points The point or points to locate on the line.
 * @param isPolygon If true, the line will be treated as a polygon, meaning that there is an additional segment between the last
 *     and the first trackpoint (which can result in an index somewhere between trackPoints.length - 1 and trackPoints.length).
 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
 */
export function locateOnLine(trackPoints: LatLng[], point: LatLng, isPolygon?: boolean): { idx: number; closest: LatLng };
export function locateOnLine(trackPoints: LatLng[], points: LatLng[], isPolygon?: boolean): Array<{ idx: number; closest: LatLng }>;
export function locateOnLine(trackPoints: LatLng[][], point: LatLng, isPolygon?: boolean): { idx: [number, number]; closest: LatLng };
export function locateOnLine(trackPoints: LatLng[][], points: LatLng[], isPolygon?: boolean): Array<{ idx: [number, number]; closest: LatLng }>;
export function locateOnLine(trackPoints: LatLng[] | LatLng[][], point: LatLng, isPolygon?: boolean): { idx: number | [number, number]; closest: LatLng };
export function locateOnLine(trackPoints: LatLng[] | LatLng[][], points: LatLng[], isPolygon?: boolean): Array<{ idx: number | [number, number]; closest: LatLng }>;
export function locateOnLine(trackPoints: LatLng[] | LatLng[][], points: LatLng | LatLng[], isPolygon = false): { idx: number | [number, number]; closest: LatLng } | Array<{ idx: number | [number, number]; closest: LatLng }> {
	const flat = isFlat(trackPoints);
	let normalizedTrackPoints = flat ? [trackPoints] : trackPoints;

	if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
		throw new Error("Line doesn't have any track points.");
	}

	if (isPolygon) {
		normalizedTrackPoints = normalizedTrackPoints.map((trackPoints) => [...trackPoints, trackPoints[0]]);
	}

	// Inspired by L.GeometryUtil.locateOnLine() (https://github.com/makinacorpus/Leaflet.GeometryUtil/blob/75fc60255cc973c931c069f281b6514a8904ee21/src/leaflet.geometryutil.js#L567)
	// but much more performant for our use case:
	// - we don't need precise line distances, just the index of the closest segment and the fraction on it
	// - we need to calculate the index for multiple points on multiple lines, which is more performant if we need
	//   to project the points just once.

	const projectedPoints = (Array.isArray(points) ? points : [points]).map((point) => project(point));

	const data: Array<{ sqDist: number; idx: [number, number]; closest: Point }> = [];

	for (let i = 0; i < normalizedTrackPoints.length; i++) {
		let pointA: Point;
		let pointB = project(normalizedTrackPoints[i][0]);
		for (let j = 1; j < normalizedTrackPoints[i].length; j++) {
			pointA = pointB;
			pointB = project(normalizedTrackPoints[i][j]);

			for (let k = 0; k < projectedPoints.length; k++) {
				const point = projectedPoints[k];
				const closest = closestPointOnSegment(point, pointA, pointB);
				const sqDist = pointDistance(point, closest, true);
				if (data[k] == null || sqDist < data[k].sqDist) {
					data[k] = { sqDist, idx: [i, j - 1 + closest.t], closest };
				}
			}
		}
	}

	const results = data.map((d) => {
		return {
			idx: flat ? d.idx[1] : d.idx,
			closest: unproject(d.closest)
		};
	});

	return Array.isArray(points) ? results : results[0];
}