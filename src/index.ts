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
 * Calculates the closest point to a point on a segment between two points. The output will be written to the `output` object.
 */
function closestPointOnSegment(point: Point, x1: number, y1: number, x2: number, y2: number, output: Point & {
	/** The percentage where between point 1 (0.0) and point 2 (1.0) the closest point is located.  */
	t: number
}): void {
	// This function will be called many times while iterating over the line segments, so it is optimized for performance:
	// - Accepting the coordinates as simple number arguments avoids having to create Point objects, which would greatly
	//   decrease performance.
	// - Writing the result into an existing object rather than returning a new object also greatly improves performance.

	const dx = x2 - x1;
	const dy = y2 - y1;
	const dot = dx * dx + dy * dy;
	output.t = dot > 1 ? Math.max(0, Math.min(1, (((point.x - x1) * dx + (point.y - y1) * dy) / dot))) : 0;
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

export type PointLocation<T extends LatLng[] | LatLng[][]> = {
	/**
	 * The fractional index where the point is located on the line. For example, if it is located half way between track point 2 and 3,
	 * the value will be 2.5. For single lines (LineString and Polygon), this will be a number, and for multi lines (MultiLineString
	 * and MultiPolygon) it will be a tuple of two numbers, the first representing the index of the line section and the second the
	 * fractional index within that section.
	 */
	idx: Idx<T>;

	/**
	 * The coordinates of the closest point on the line.
	 */
	closest: LatLng;
}

export class LineString<T extends LatLng[] | LatLng[][]> {

	/** The track points; a pair of two consecutive values represents the latitude and longitude of one point. */
	protected readonly trackPoints: number[][];

	/**
	 * If true, the track points were provided as a single-dimensional array, so all the points are in this.trackPoints[0] and indexes
	 * should be returned as a single number.
	 */
	protected readonly flat: boolean;

	/**
	 * @throws Throws an error if trackPoints does not contain at least two track points (or at least one section with two track points).
	 * @param trackPoints The track points of the line. If this is an array of arrays, it is treated as a MultiLineString/MultiPolygon.
	 * @param isPolygon If true, the line will be treated as a polygon, meaning that a copy of the first track point (of each line section)
	 *     will be added to the end of the track points (of that section). For regular lines, the index of a closest point can be between
	 *     0 and trackPoints.length - 1, but for polygons, it can be between 0 and trackPoints.length.
	 */
	constructor(trackPoints: T, isPolygon = false) {
		this.flat = isFlat(trackPoints);
		const normalizedTrackPoints = (this.flat ? [trackPoints] : trackPoints) as LatLng[][];

		if (!normalizedTrackPoints.some((t) => t.length >= 2)) {
			throw new Error("Line doesn't have any track points.");
		}

		// Map the track points to a flat array of latitudes and longitudes, which is much more performant to iterate over than
		// an array of LatLng objects.
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
	 * @param points The point or points to locate on the line.
	 * @returns If points is an array of points, returns an array matching its length and order. Otherwise a single object is returned.
	 *     If trackPoints is an array of lines, the resulting index will be a tuple where the first number is the index of the line
	 *     and the second number is the fractional index on that line. Otherwise, the fractional index is returned as a number.
	 */
	locate(point: LatLng): { idx: Idx<T>; closest: LatLng };
	locate(points: LatLng[]): Array<{ idx: Idx<T>; closest: LatLng }>;
	locate(points: LatLng | LatLng[]): { idx: Idx<T>; closest: LatLng } | Array<{ idx: Idx<T>; closest: LatLng }> {
		const projectedPoints = (Array.isArray(points) ? points : [points]).map((point) => project(point));

		// The properties of these will be overwritten on each iteration, which is much more performant than creating a new object
		// each time.
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

					closestPointOnSegment(point, x1, y1, x2, y2, closest);
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