# Makes the STEP fixtures with OpenCascade, through build123d (pip install build123d).
#   python make.py test/fixtures/step
# The expected bounds and areas in expected.json come from the same kernel.
import sys
from build123d import *

out = sys.argv[1]

def save(part, name):
    export_step(part, f"{out}/{name}.step")
    print(name, len(part.faces()), "faces")

# plate: through holes, rounded vertical corners, chamfered top edges
with BuildPart() as plate:
    Box(60, 40, 8)
    fillet(plate.edges().filter_by(Axis.Z), radius=6)
    chamfer(plate.edges().group_by(Axis.Z)[-1], length=1)
    with Locations((-20, -10), (20, -10), (-20, 10), (20, 10)):
        Hole(radius=3)
    with Locations((0, 0, 4)):
        CounterBoreHole(radius=4, counter_bore_radius=7, counter_bore_depth=3)
save(plate.part, "plate")

# turned shaft: steps, a cone, a ball end, a fillet
with BuildPart() as shaft:
    with BuildSketch(Plane.XZ) as sk:
        with BuildLine() as ln:
            Polyline((0, 0), (10, 0), (10, 20), (6, 25), (6, 40), (8, 40), (8, 50), (0, 50), close=True)
        make_face()
    revolve(axis=Axis.Z)
    fillet(shaft.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[0], radius=2)
    with Locations((0, 0, 50)):
        Sphere(8, mode=Mode.ADD)
save(shaft.part, "shaft")

# a box with every edge rounded: planes, quarter cylinders, sphere corners
with BuildPart() as rounded:
    Box(30, 20, 10)
    fillet(rounded.edges(), radius=3)
save(rounded.part, "rounded_box")

# an L bracket with a hole through each wall and a fillet inside the bend
with BuildPart() as bracket:
    with BuildSketch(Plane.XZ):
        with BuildLine():
            Polyline((0, 0), (50, 0), (50, 6), (6, 6), (6, 40), (0, 40), close=True)
        make_face()
    extrude(amount=30, both=False)
    inner = bracket.edges().filter_by(Axis.Y).filter_by_position(Axis.X, 5.9, 6.1).filter_by_position(Axis.Z, 5.9, 6.1)
    fillet(inner, radius=4)
    with Locations(Location((30, -15, 6), (0, 0, 0))):
        Hole(radius=4)
save(bracket.part, "bracket")

save(Sphere(10), "sphere")
save(Torus(20, 5), "torus")
save(Cone(10, 4, 20), "cone")

# an elliptical extrusion: planar faces bounded by ellipses
with BuildPart() as ell:
    with BuildSketch():
        Ellipse(20, 10)
    extrude(amount=5)
save(ell.part, "ellipse")

# crossing holes: their intersection curves are not circles about one axis
with BuildPart() as cross:
    Cylinder(10, 40)
    Cylinder(6, 40, rotation=(90, 0, 0), mode=Mode.SUBTRACT)
save(cross.part, "cross_holes")

# a lofted free-form shape
with BuildPart() as loft_:
    with BuildSketch():
        Circle(10)
    with BuildSketch(Plane.XY.offset(20)):
        Rectangle(10, 6)
    loft()
save(loft_.part, "loft")
