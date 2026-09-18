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

function project2(latlng: LatLng, output: number[], outputOffset: number): void {
	const sin = Math.sin(latlng.lat / d);
	output[outputOffset] = R * latlng.lng / d;
	output[outputOffset + 1] = R * Math.log((1 + sin) / (1 - sin)) / 2;
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

type Idx<T extends LatLng[] | LatLng[][]> = T extends LatLng[][] ? [number, number] : number;

const boxSize = 500;

export class JsPolyline1<T extends LatLng[] | LatLng[][]> {

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
			const t = this.trackPoints[i];

			const bboxes = new Array<{ top: number; right: number; bottom: number; left: number; start: number; end: number }>(Math.ceil(t.length / boxSize));
			for (let b = 0; b < bboxes.length; b++) {
				bboxes[b] = { top: Infinity, right: -Infinity, bottom: -Infinity, left: Infinity, start: b * boxSize, end: Math.min((b + 1) * boxSize, t.length) };
				for (let j = bboxes[b].start; j < bboxes[b].end; j += 2) {
					bboxes[b].top = Math.min(bboxes[0].top, t[j + 1]);
					bboxes[b].right = Math.max(bboxes[0].right, t[j]);
					bboxes[b].bottom = Math.max(bboxes[0].bottom, t[j + 1]);
					bboxes[b].left = Math.min(bboxes[0].left, t[j]);
				}
			}

			for (let k = 0; k < projectedPoints.length; k++) {
				const point = projectedPoints[k];
				const d = data[k];

				const bboxDist = bboxes.map((b, i) => {
					const dx = Math.max(b.left - point.x, 0, point.x - b.right);
					const dy = Math.max(b.top - point.y, 0, point.y - b.bottom);
					return { start: b.start, end: b.end, sqDist: dx * dx + dy * dy };
				}).sort((a, b) => a.sqDist - b.sqDist);

				for (const b of bboxDist) {
					if (d.sqDist !== -1 && b.sqDist > d.sqDist) {
						break;
					}

					for (let j = b.start + 2; j < b.end; j += 2) {
						const x1 = t[j - 2];
						const y1 = t[j - 1];
						const x2 = t[j];
						const y2 = t[j + 1];

						closestPointOnSegment2(point, x1, y1, x2, y2, closest);
						const sqDist = pointDistance(point, closest, true);
						if (d.sqDist === -1 || sqDist < d.sqDist) {
							d.sqDist = sqDist;
							d.idx1 = i;
							d.idx2 = j / 2 - 1 + closest.t;
							d.x = closest.x;
							d.y = closest.y;
						}
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

export class JsPolyline2<T extends LatLng[] | LatLng[][]> {

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

		for (let k = 0; k < projectedPoints.length; k++) {
			const point = projectedPoints[k];
			const d = data[k];
			for (let i = 0; i < this.trackPoints.length; i++) {
				for (let j = 2; j < this.trackPoints[i].length; j += 2) {
					const x1 = this.trackPoints[i][j - 2];
					const y1 = this.trackPoints[i][j - 1];
					const x2 = this.trackPoints[i][j];
					const y2 = this.trackPoints[i][j + 1];

					closestPointOnSegment2(point, x1, y1, x2, y2, closest);
					const sqDist = pointDistance(point, closest, true);
					if (d.sqDist === -1 || sqDist < d.sqDist) {
						d.sqDist = sqDist;
						d.idx1 = i;
						d.idx2 = j / 2 - 1 + closest.t;
						d.x = closest.x;
						d.y = closest.y;
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