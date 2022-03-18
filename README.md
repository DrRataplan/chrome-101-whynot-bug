# Chrome 101 if condition bug repro

To run this:

* Clone this repo
* Host the files using your favourite static file server (for example `npx http-server`)
* Open the `index.html` in your favourite browser
* Look at the preformatted log

## Expected

* The log should show a long list of `Run ## was successful!` statements

## Actual in Chrome `Version 101.0.4929.5 (Official Build) dev (64-bit)`:

```
If anything happens, this log will be written to!
 Run 0 was successful!
 Run 1 was successful!
 In the `if (alreadyScheduled) {...}` of stepToNextGeneration. With `alreadyScheduled` set to: false
 Run 2 was broken!
```
