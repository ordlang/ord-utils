# ord-utils

Tools for the [Ord specification](https://github.com/ordlang/ord). No dependencies; Node 18 or later.

## ordtest

The examples in the Ord specs are tests: fenced blocks with the info string `example` ([Test format](https://github.com/ordlang/ord/blob/main/Test_format.md), part B). `ordtest` extracts, checks and runs them against an implementation.

```sh
ordtest list     SPEC          # number, line, kind and rules of each test
ordtest extract  SPEC          # all tests as JSON
ordtest lint     SPEC          # check the tests themselves: blocks, dumps, ranges, JSON
ordtest coverage SPEC          # rules that no test names, by letter
ordtest run      SPEC [--dump CMD] [--fmt CMD] [--from-json CMD] [--to-json CMD]
                      [--from-csv CMD] [--to-csv CMD] [--graph CMD] [--only ID]...
```

`run` gives each test's input on standard input to the command for its kind and compares standard output with the expected output. Tests whose command isn't given are skipped.

```sh
node ordtest.mjs run Ord_Specification.md --dump "ord dump -" --fmt "ord fmt -"
```

Install it from GitHub to get the `ordtest` command:

```sh
npm install --save-dev github:ordlang/ord-utils
```

## License

MIT. The specification itself is CC BY 4.0.
