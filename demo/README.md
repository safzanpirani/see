# demo

`see-demo.gif` is generated, not recorded by hand.

```sh
bun run demo/make-sample.ts   # regenerate sample.png (deterministic, no network)
vhs demo/demo.tape            # re-record the GIF  (brew install vhs)
```

`sample.png` is a synthetic dashboard so the demo has real text, real layout and
real numbers to find without leaning on anything private.
