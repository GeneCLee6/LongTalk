# Third-party notices

LongTalk ships the following third-party code to the browser in addition to its npm dependencies'
own licenses (React, react-router, styled-components: MIT). This file is served with the app as
`/third-party-notices.txt` (vite.config.ts).

## RNNoise (advanced noise suppression, e6-t02)

The files `/assets/rnnoise-*.wasm` and `/assets/rnnoise_simd-*.wasm` are
[RNNoise](https://github.com/xiph/rnnoise) compiled to WebAssembly by
[shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm) (build scripts under the
Apache License 2.0, Copyright 2021-2025 Takeru Ohta and Shiguredo Inc.; the generated wasm is
under RNNoise's license below), as distributed in the npm package
[@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1 (MIT).
LongTalk uses only those two wasm files; the AudioWorklet that runs them is LongTalk's own
(`src/media/rnnoise.worklet.ts`). The wasm also contains parts of the Emscripten runtime
(emmalloc, memcpy), which Emscripten licenses under the MIT and University of Illinois/NCSA
licenses.

### RNNoise — BSD 3-Clause License

```text
Copyright (c) 2007-2017, 2024 Jean-Marc Valin
Copyright (c) 2023 Amazon
Copyright (c) 2017, Mozilla
Copyright (c) 2005-2017, Xiph.Org Foundation
Copyright (c) 2003-2004, Mark Borgerding

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of the Xiph.Org Foundation nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### @sapphi-red/web-noise-suppressor — MIT License

```text
MIT License

Copyright (c) 2022 翠 / green

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MediaPipe Tasks Vision and the selfie segmentation model (background blur, e6-t06)

The files `/assets/blurWorker-*.js` (bundling `@mediapipe/tasks-vision`),
`/assets/vision_wasm_internal-*.js` and `/assets/vision_wasm_internal-*.wasm` come from the npm
package [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) 0.10.35, Copyright
The MediaPipe Authors, under the Apache License 2.0. The file `/assets/selfie_segmenter-*.tflite`
is Google's MediaPipe selfie segmentation model (`selfie_segmenter.tflite`, float16,
sha-256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`), from
`storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/`, kept in
this repository under the same project and license. They are served unmodified, from LongTalk's
own site. The wasm also contains TensorFlow Lite (Apache License 2.0) and other libraries under
permissive licenses; the Apache License's full text is at
<https://www.apache.org/licenses/LICENSE-2.0>.

LongTalk stays on 0.10.35 on purpose: from 1.0.0 the package sends usage metrics to Google
(`odml.pa.googleapis.com`), which LongTalk's privacy policy and Content-Security-Policy do not allow.
