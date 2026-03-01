#!/usr/bin/env sh

ENV_VAR=process.env.NODE_ENV

rm -rf dist/

npm exec --no esbuild -- \
  --format=esm --platform=neutral --bundle --packages=external --define:$ENV_VAR='"production"' --outfile=dist/lib.js src/lib.ts

npm exec --no esbuild -- \
  --format=esm --platform=neutral --bundle --packages=external --define:$ENV_VAR='"development"' --outfile=dist/lib.development.js src/lib.ts

if test -n "$SKIP_TS"; then
  exit
fi

DECL_OUT=$(mktemp -d)


echo
echo Generating declarations
echo

npm exec --no tsc -- --noEmit false --declaration --emitDeclarationOnly --outDir $DECL_OUT

cp $DECL_OUT/lib.d.ts dist/

rm -r $DECL_OUT/
