/// <reference lib="webworker" />
/**
 * Module-worker entry bundled by the Angular builder. It simply loads the
 * meikiocr-web worker (which imports the pinned onnxruntime-web build). The
 * matching ORT .wasm/.mjs files are served from `ocr-assets/`.
 */
import 'meikiocr-web/worker';
