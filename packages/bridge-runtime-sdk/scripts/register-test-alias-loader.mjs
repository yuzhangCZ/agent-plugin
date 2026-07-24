import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRootUrl = pathToFileURL(`${path.join(packageDir, 'src')}${path.sep}`).href;

const loaderSource = `
const srcRootUrl = ${JSON.stringify(srcRootUrl)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return nextResolve(new URL(specifier.slice(2), srcRootUrl).href, context);
  }

  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
