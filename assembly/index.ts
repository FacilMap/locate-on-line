const R = 6378137;
const d = 180 / Math.PI;

/**
 * Projects geographic coordinates into pixel coordinates.
 * @param output The resulting x and y values will be written into this array.
 * @param outputOffset The resulting x value will be written into the output array at this position, the y value one position later
 */
function project(lat: f64, lon: f64, output: StaticArray<f64>, outputOffset: i32): void {
	output[outputOffset] = R * lon / d;
	const sin = Math.sin(lat / d);
	output[outputOffset + 1] = R * Math.log((1 + sin) / (1 - sin)) / 2;
}

/**
 * Projects geographic coordinates into pixel coordinates.
 * @param input An array of geographic coordinates where two subsequent values always represent the latitude and longitude
 * @return An array of pixel coordinates where two subsequent values always represent x and y
 */
function projectAll(input: StaticArray<f64>): StaticArray<f64> {
	const output = new StaticArray<f64>(input.length)
	for (let i = 0; i < input.length; i += 2) {
		project(input[i], input[i + 1], output, i);
	}
	return output;
}

/**
 * Projects pixel coordinates into geographic coordinates.
 * @param output The resulting latitude and longitue will be written into this array.
 * @param outputOffset The resulting latitude will be written into the output array at this position, the longitude one position later
 */
function unproject(x: f64, y: f64, output: StaticArray<f64>, outputOffset: i32): void {
	output[outputOffset] = (2 * Math.atan(Math.exp(y / R)) - (Math.PI / 2)) * d;
	output[outputOffset + 1] = x * d / R;
}

/**
 * Returns the distance between two pixel coordinates.
 * @param sq If true, the sqaure of the distance is returned instead to save the calculation of the square root.
 */
@inline
function pointDistance(x1: f64, y1: f64, x2: f64, y2: f64, sq: boolean = false): f64 {
	const x = x2 - x1;
	const y = y2 - y1;
	const squareResult = x * x + y * y;
	return sq ? squareResult : Math.sqrt(squareResult);
}

/**
 * Calculates the closest point to a point on a segment between two points.
 * @param result Must be an array with 3 items. The x and y coordinates of the result are stored in the first two items. The third item is set to the
 * percentage where the result lies on the segment (0 meaning exactly on the first point, 1 meaning exactly on the second point).
 */
@inline
function closestPointOnSegment(x: f64, y: f64, x1: f64, y1: f64, x2: f64, y2: f64, result: StaticArray<f64>): void {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const dot = dx * dx + dy * dy;
	result[2] = dot > 0 ? Math.max(0, Math.min(1, (((x - x1) * dx + (y - y1) * dy) / dot))) : 0.5;
	result[0] = x1 + dx * result[2];
	result[1] = y1 + dy * result[2];
}

/**
 * Calculates the closest point on a multi polyline for each point in the "points" array.
 *
 * The multi polyline is defined by `trackPoints` and `sectionOffsets`. In `trackPoints`, two subsequent values represent the latitude and longitude of a
 * point on the polyline. `sectionOffsets` defines the indexes in the `trackPoints` array where new sections of the multi polyline start. The first section
 * is always assumed to start at 0 and the last section to end at the end of `trackPoints`, meaning that if `segmentOffsets` is empty, the multi polyline has
 * one section.
 *
 * In the resulting array, four subsequent values always represent the result for one point:
 * - The first value is the section index where the closest point is located. For example, `0` means the first section, so the one before `sectionOffsets[0]`.
 * - The second value is the index within the section where the closest point is located, as a fractional position within the segment added. For example, if
 *   the closest point is on the segment between point 10 and 11 (represented by trackPoints[20],trackPoints[21] and trackPoints[22],trackPoints[23] if it is
 *   in the first section), the value would be 10 if the closest point is exactly on the first point of the segment, 10.5 if it is exactly half way between the
 *   two points, and 11 if it is exactly on the second point.
 * - The third value is the latitude of the closest point
 * - The fourth value is the longitude of the closest point
 *
 * @param points The points for each of which to look for the closest point on the multi polyline. Two subsequent values in the array always represent
 *               the latitude and longitude of one point.
 */
export function locateOnLine(trackPointsPtr: usize, sectionOffsetsPtr: usize, points: StaticArray<f64>): StaticArray<f64> {
	// Inspired by L.GeometryUtil.locateOnLine() (https://github.com/makinacorpus/Leaflet.GeometryUtil/blob/75fc60255cc973c931c069f281b6514a8904ee21/src/leaflet.geometryutil.js#L567)
	// but much more performant for our use case:
	// - we don't need precise line distances, just the index of the closest segment and the fraction on it
	// - we need to calculate the index for multiple points on multiple lines, which is more performant if we need
	//   to project the points just once.

	const trackPoints = changetype<StaticArray<f64>>(trackPointsPtr);
	const sectionOffsets = changetype<StaticArray<i32>>(sectionOffsetsPtr);

	const projectedPoints = projectAll(points);

	const closest = new StaticArray<f64>(3);

	const numberOfPoints = points.length / 2;
	const dataSqDist = new StaticArray<f64>(numberOfPoints).fill(-1);
	const dataClosestX = new StaticArray<f64>(numberOfPoints);
	const dataClosestY = new StaticArray<f64>(numberOfPoints);
	const dataIdx = new StaticArray<f64>(numberOfPoints);

	for (let i = -1; i < sectionOffsets.length; i++) {
		const start = i == -1 ? 0 : sectionOffsets[i];
		const end = i < sectionOffsets.length - 1 ? sectionOffsets[i + 1] : trackPoints.length;
		for (let j = start + 2; j < end; j += 2) {
			const x1 = trackPoints[j - 2];
			const y1 = trackPoints[j - 1];
			const x2 = trackPoints[j];
			const y2 = trackPoints[j + 1];

			for (let k = 0, pointNumber = 0; k < projectedPoints.length; k += 2, pointNumber++) {
				const x = projectedPoints[k];
				const y = projectedPoints[k + 1];
				closestPointOnSegment(x, y, x1, y1, x2, y2, closest);
				const sqDist = pointDistance(x, y, closest[0], closest[1], true);
				if (dataSqDist[pointNumber] == -1 || sqDist < dataSqDist[pointNumber]) {
					dataSqDist[pointNumber] = sqDist;
					dataClosestX[pointNumber] = closest[0];
					dataClosestY[pointNumber] = closest[1];
					dataIdx[pointNumber] = j - 2 + closest[2];
				}
			}
		}
	}

	const result = new StaticArray<f64>(numberOfPoints * 4);
	for (let pointNumber = 0, i = 0; pointNumber < numberOfPoints; pointNumber++, i += 4) {
		const idx = floor(dataIdx[pointNumber]);
		const t = dataIdx[pointNumber] - idx;
		if (sectionOffsets.length == 0 || idx >= sectionOffsets[sectionOffsets.length - 1]) {
			result[i] = sectionOffsets.length;
			result[i + 1] = (idx - (sectionOffsets.length == 0 ? 0 : sectionOffsets[sectionOffsets.length - 1])) / 2 + t;
		} else {
			for (let j = 0; j < sectionOffsets.length; j++) {
				if (idx < sectionOffsets[j]) {
					result[i] = j;
					result[i + 1] = (idx - (j == 0 ? 0 : sectionOffsets[j - 1])) / 2 + t;
					break;
				}
			}
		}

		unproject(dataClosestX[pointNumber], dataClosestY[pointNumber], result, i + 2);
	}
	return result;
}

export function createF64Array(length: i32): usize {
	const result = new StaticArray<f64>(length);
	return changetype<usize>(result);
}

export function createI32Array(length: i32): usize {
	const result = new StaticArray<i32>(length);
	return changetype<usize>(result);
}