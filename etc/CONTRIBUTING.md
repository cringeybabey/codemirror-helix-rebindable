# Sign the DCO

You need to "sign off" your commits with `git commit -s` to indicate that you agree to the [Developer Certificate of Origin](https://developercertificate.org/), also reproduced in-tree [here](DCO.txt).

Please be aware that, most likely, this forbids LLM-assisted contributions.

# Basic setup

With Node.js and `npm` installed:

```bash
# Install dependencies
npm i

# Run the demo playground (with livereloading)
npm run demo

# Build the package
npm run build

# Run the test suite
# (you need to run a build before)
npm test
```
