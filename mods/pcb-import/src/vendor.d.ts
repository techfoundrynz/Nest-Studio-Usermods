declare module "gerber-parser" {
  import { Transform } from "node:stream";
  function parser(options: { filetype: "gerber" | "drill" }): Transform;
  export = parser;
}
declare module "gerber-plotter" {
  import { Transform } from "node:stream";
  function plotter(): Transform;
  export = plotter;
}
declare module "earcut" {
  function earcut(data: number[], holes?: number[], dimensions?: number): number[];
  export = earcut;
}
declare module "clipper-lib" {
  namespace ClipperLib {
    interface Point { X: number; Y: number }
    type Path = Point[];
    type Paths = Path[];
    class PolyNode { Contour(): Path; Childs(): PolyNode[]; IsHole(): boolean }
    class PolyTree extends PolyNode {}
    const ClipType: { ctUnion: number; ctDifference: number; ctIntersection: number };
    const PolyType: { ptSubject: number; ptClip: number };
    const PolyFillType: { pftNonZero: number; pftEvenOdd: number };
    const JoinType: { jtRound: number };
    const EndType: { etOpenRound: number };
    class Clipper {
      StrictlySimple: boolean;
      AddPaths(paths: Paths, type: number, closed: boolean): boolean;
      Execute(type: number, result: Paths | PolyTree, subjectFill: number, clipFill: number): boolean;
      static Area(path: Path): number;
    }
    class ClipperOffset {
      constructor(miterLimit?: number, arcTolerance?: number);
      AddPath(path: Path, join: number, end: number): void;
      Execute(result: Paths, delta: number): void;
    }
  }
  export = ClipperLib;
}
