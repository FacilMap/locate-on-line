# locate-on-line

This is a small library with the purpose to find the closest point to a specific point on a Leaflet Polyline or Polygon. To make the library compatible with other use cases (such as using it in the backend), it does not depend on or use Leaflet, but its data types are compatible with Leaflet.

This library assumes that the map uses the Spherical Mercator projection.

The library is written in TypeScript.


## Installation

locate-on-line is available on [NPM](https://www.npmjs.com/package/locate-on-line). Install it by running `npm install -S locate-on-line` or `yarn add locate-on-line`.


## Usage

```js
import { LineString } from "locate-on-line";

const line = new LineString([
	{ lat: 51.348, lng: -1.793 },
	{ lat: 51.351, lng: -1.805 },
	{ lat: 51.359, lng: -1.701 }
]);

const closest = line.locate({ lat: 51.355, lng: -1.795 });
console.log(closest); // { idx: 1.1021, closest: { lat: 51.35181, lng: -1.79437 } }
```

You initialize a `LineString` object with an array of track points and then call `line.locate(point)` to find the closest point to `point` on the line. You can call `locate()` multiple times with different points on the same `LineString`, for example to continuously find the point on the line closest to the mouse cursor as the mouse moves around. The `LineString` object caches the projected positions of the track point to make consecutive lookups a bit more performant. If the line changes, you need to construct a new `LineString` object.

The `locate` function returns the point on the line closest to the given location. The returned point can be either one of the track points, or a point that is on a straight line connecting two consecutive track points. The returned `closest` property contains the exact coordinates of the closest point. The returned `idx` property is the fractional index where the closest point is located on the line. In the above example, the line has 3 track points with the indexes 0, 1 and 2. If the closest point were one of those track points, `idx` would be an integer (0, 1 or 2). The returned idx `1.1021` indicates that the returned point is located between points 1 and 2, or to be precise 10.21 % on the way from track point 1 to track point 2.

A `LineString` must have at least two track points. (MultiLineStrings must have at least one section with at least two track points.) If it doesn’t, the constructor will throw an exception.


### Usage with MultiLineStrings

Like Leaflet Polylines, this library also supports MultiLineStrings. Those are line strings that consist of multiple sections that can be disconnected from each other. With MultiLineStrings, this library returns the single point that is the closest to the given point on any of the sections.

Like with Leaflet Polylines, MultiLineStrings are specified by a nested array of track points.

```js
const line = new LineString([
	[
		{ lat: 10.1, lng: 5.2 },
		{ lat: 10.2, lng: 5.3 },
		{ lat: 10.3, lng: 5.4 }
	],
	[
		{ lat: 51.348, lng: -1.793 },
		{ lat: 51.351, lng: -1.805 },
		{ lat: 51.359, lng: -1.701 }
	]
]);

const closest = line.locate({ lat: 51.355, lng: -1.795 });
console.log(closest); // { idx: [1, 1.1021], closest: { lat: 51.35181, lng: -1.79437 } }
```

When used with MultiLineStrings, the returned `idx` property is a tuple of two numbers rather than a single number. The first number is the index of the section on which the closest point is located, and the second number is the fractional index within the track points of that section.


### Usage with Polygons/MultiPolygons

Geometrically, polygons are simply polylines that form a closed loop, so their last track point is equal to their first. This is also how Leaflet represents them, with Polygon being a sub-class of Polyline.

Passing `true` as a second argument to the `LineString` will make the line be treated as a polygon.

```js
const line = new LineString([
	{ lat: 51.348, lng: -1.793 },
	{ lat: 51.351, lng: -1.805 },
	{ lat: 51.359, lng: -1.701 }
], true);

const closest = line.locate({ lat: 51.355, lng: -1.795 });
console.log(closest); // { idx: 1.1021, closest: { lat: 51.35181, lng: -1.79437 } }
```

Internally, this will simply add a copy of the first track point to the end. This means that the line in the example is considered to have 4 track points instead of 3, so the resulting `idx` can be between `0` and `3`.

Also for polygons, the function will return the closest point on the _line_, so on the outline of the polygon. This means that even if the supplied point lies within the polygon, the closest point on its outline will be returned.

MultiPolygons are equally supported by providing a nested array of track points. For these, a copy of the first track point of each section is added to the end of the track points of that section.


### Looking up multiple points

For your convenience, the library also supports looking up multiple points at once. At the moment this does not have any performance benefit over looking up each point individually, but maybe this will change in the future.

```js
const line = new LineString([
	{ lat: 51.348, lng: -1.793 },
	{ lat: 51.351, lng: -1.805 },
	{ lat: 51.359, lng: -1.701 }
], true);

const closest = line.locate([
	{ lat: 51.355, lng: -1.795 },
	{ lat: 51.365, lng: -1.695 }
]);
console.log(closest);
// [
//   { idx: 1.1021, closest: { lat: 51.35181, lng: -1.79437 } },
//   { idx: 2, closest: { lat: 51.359, lng: -1.701 } }
// ]
```

Providing an array of points to `line.locate()` will make it return an array of results.