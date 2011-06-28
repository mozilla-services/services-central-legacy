// When the debugger is triggered twice from the same stack frame, the same
// Debug.Frame object must be passed to the hook both times.

var g = newGlobal('new-compartment');
var hits, frame;
var dbg = Debug(g);
dbg.hooks = {
    debuggerHandler: function (f) {
        if (hits++ == 0)
            frame = f;
        else
            assertEq(f, frame);
    }
};

hits = 0;
g.evaluate("debugger; debugger;");
assertEq(hits, 2);

hits = 0;
g.evaluate("function f() { debugger; debugger; }  f();");
assertEq(hits, 2);

hits = 0;
g.evaluate("eval('debugger; debugger;');");
assertEq(hits, 2);