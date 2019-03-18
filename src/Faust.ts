import { LibFaustLoader, LibFaust } from "./LibFaustLoader";
import sha1 from "crypto-libraries/sha1";
import { TCompiledDsp, TCompiledCode, TCompiledCodes, TCompiledStrCodes, FaustCompileOptions } from "./types";
import { FaustWasmToScriptProcessor } from "./FaustWasmToScriptProcessor";
import { FaustAudioWorkletProcessorWrapper, FaustData } from "./FaustAudioWorkletProcessor";
import { FaustAudioWorkletNode } from "./FaustAudioWorkletNode";

import * as libFaustDataURI from "./wasm/libfaust-wasm.wasm";
import * as mixer32DataURI from "./wasm/mixer32.wasm";

export const mixer32Base64Code = (mixer32DataURI as unknown as string).split(",")[1];
// import * as Binaryen from "binaryen";

const ab2str = (buf: ArrayBuffer): string => buf ? String.fromCharCode.apply(null, new Uint8Array(buf)) : null;
const str2ab = (str: string) => {
    if (!str) return null;
    const buf = new ArrayBuffer(str.length);
    const bufView = new Uint8Array(buf);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return buf;
};
export class Faust {
    private libFaust: LibFaust;
    private createWasmCDSPFactoryFromString: ($name: number, $code: number, argvAuxLength: number, $argv: number, $errorMsg: number, internalMemory: boolean) => number;
    private deleteAllWasmCDSPFactories: () => void;
    private expandCDSPFromString: ($name: number, $code: number, argvLength: number, $argv: number, $shaKey: number, $errorMsg: number) => number;
    private getCLibFaustVersion: () => number;
    private getWasmCModule: ($moduleCode: number) => number;
    private getWasmCModuleSize: ($moduleCode: number) => number;
    private getWasmCHelpers: ($moduleCode: number) => number;
    private freeWasmCModule: ($moduleCode: number) => void;
    private freeCMemory: ($: number) => number;
    private cleanupAfterException: () => void;
    private getErrorAfterException: () => number;
    private getLibFaustVersion: () => string;
    debug = false;
    private dspCount = 0;
    private dspTable = {} as { [key: string]: TCompiledDsp };
    private _log = [] as string[];
    constructor(options?: { debug: boolean; libFaust: LibFaust }) {
        this.debug = options && options.debug ? true : false;
        if (options && options.libFaust) {
            this.libFaust = options.libFaust;
            this.importLibFaustFunctions();
        }
    }
    async loadLibFaust(url?: string) {
        this.libFaust = await LibFaustLoader.load(url || (libFaustDataURI as unknown as string));
        this.importLibFaustFunctions();
        return this;
    }
    get ready() {
        return this.loadLibFaust();
    }
    private importLibFaustFunctions() {
        if (!this.libFaust) return;
        // Low-level API
        this.createWasmCDSPFactoryFromString = this.libFaust.cwrap("createWasmCDSPFactoryFromString", "number", ["number", "number", "number", "number", "number", "number"]);
        this.deleteAllWasmCDSPFactories = this.libFaust.cwrap("deleteAllWasmCDSPFactories", null, []);
        this.expandCDSPFromString = this.libFaust.cwrap("expandCDSPFromString", "number", ["number", "number", "number", "number", "number", "number"]);
        this.getCLibFaustVersion = this.libFaust.cwrap("getCLibFaustVersion", "number", []);
        this.getWasmCModule = this.libFaust.cwrap("getWasmCModule", "number", ["number"]);
        this.getWasmCModuleSize = this.libFaust.cwrap("getWasmCModuleSize", "number", ["number"]);
        this.getWasmCHelpers = this.libFaust.cwrap("getWasmCHelpers", "number", ["number"]);
        this.freeWasmCModule = this.libFaust.cwrap("freeWasmCModule", null, ["number"]);
        this.freeCMemory = this.libFaust.cwrap("freeCMemory", null, ["number"]);
        this.cleanupAfterException = this.libFaust.cwrap("cleanupAfterException", null, []);
        this.getErrorAfterException = this.libFaust.cwrap("getErrorAfterException", "number", []);
        this.getLibFaustVersion = () => this.libFaust.UTF8ToString(this.getCLibFaustVersion());
    }
    async getNode(code: string, options: FaustCompileOptions) {
        const audioCtx = options.audioCtx;
        const voices = options.voices;
        const useWorklet = options.useWorklet;
        const bufferSize = options.bufferSize;
        const argv = [] as string[];
        for (const key in options.argv) {
            argv.push("-" + key);
            argv.push(options.argv[key]);
        }
        const compiledDsp = await this.compileCodes(code, argv, voices ? false : true);
        if (!compiledDsp) return null;
        const node = await this[useWorklet ? "getAudioWorkletNode" : "getScriptProcessorNode"](compiledDsp, audioCtx, useWorklet ? 128 : bufferSize, voices);
        return node as AudioWorkletNode | ScriptProcessorNode;
    }
    private compileCode(factoryName: string, code: string, argv: string[], internalMemory: boolean) {
        const codeSize = this.libFaust.lengthBytesUTF8(code) + 1;
        const $code = this.libFaust._malloc(codeSize);
        const name = "FaustDSP";
        const nameSize = this.libFaust.lengthBytesUTF8(name) + 1;
        const $name = this.libFaust._malloc(nameSize);
        const $errorMsg = this.libFaust._malloc(4096);

        this.libFaust.stringToUTF8(name, $name, nameSize);
        this.libFaust.stringToUTF8(code, $code, codeSize);

        // Add 'cn' option with the factory name
        const argvAux = argv || [];
        argvAux.push("-cn", factoryName);

        // Prepare 'argv_aux' array for C side
        const ptrSize = 4;
        const $argv = this.libFaust._malloc(argvAux.length * ptrSize);  // Get buffer from emscripten.
        let $argv_buffer = new Int32Array(this.libFaust.HEAP32.buffer, $argv, argvAux.length);  // Get a integer view on the newly allocated buffer.
        for (let i = 0; i < argvAux.length; i++) {
            const $arg_size = this.libFaust.lengthBytesUTF8(argvAux[i]) + 1;
            const $arg = this.libFaust._malloc($arg_size);
            this.libFaust.stringToUTF8(argvAux[i], $arg, $arg_size);
            $argv_buffer[i] = $arg;
        }
        try {
            const time1 = performance.now();
            const $moduleCode = this.createWasmCDSPFactoryFromString($name, $code, argvAux.length, $argv, $errorMsg, internalMemory);
            const time2 = performance.now();
            this.log("Faust compilation duration : " + (time2 - time1));

            const errorMsg = this.libFaust.UTF8ToString($errorMsg);
            if (errorMsg) this.error(errorMsg);

            /*
            // New API test

            //var code =  "process = _,_,_,_;";
            var code =  "import(\"stdfaust.lib\"); process = dm.zita_rev1;";
            //var code = "import(\"stdfaust.lib\"); vol = vslider(\"vol\", 0.6, 0, 1, 0.01); process = _+vol,_+(0.3*vol);";
            //var code = "import(\"stdfaust.lib\"); vol = vslider(\"vol\", 0.6, 0, 1, 0.01); process = (_+vol)*os.osc(440),_+(0.3*vol*os.osc(800));";
            //var code = "import(\"stdfaust.lib\"); process = os.osc(440);";

            var argv1 = faustModule.makeStringVector();
            console.log(argv1);
            argv1.push_back("-ftz");
            argv1.push_back("2");
            argv1.push_back("-cn");
            argv1.push_back(factory_name);
            argv1.push_back("-I");
            argv1.push_back("http://127.0.0.1:8000/libraries/");

            var time3 = performance.now();
            var factory_ptr = faustModule.wasm_dynamic_dsp_factory.createWasmDSPFactoryFromString2("FaustDSP", code, argv1, false);
            console.log("FACTORY JSON : " + factory_ptr.getJSON())

            var time4 = performance.now();
            console.log("C++ Faust compilation duration : " + (time4 - time3));

            if (factory_ptr) {
                console.log("factory_ptr " + factory_ptr);
                var instance_ptr = factory_ptr.createDSPInstance();
                console.log("instance_ptr " + instance_ptr);
                console.log("instance_ptr getNumInputs " + instance_ptr.getNumInputs());
                console.log("instance_ptr getNumOutputs " + instance_ptr.getNumOutputs());
                instance_ptr.init(44100);

                instance_ptr.computeJSTest(128);
                //instance_ptr.compute(128, 0, 0);

            } else {
                console.log("getErrorMessage " + faustModule.wasm_dsp_factory.getErrorMessage());
            }

            fetch('t1.wasm')
            .then(dsp_file => dsp_file.arrayBuffer())
            .then(dsp_bytes => { var factory_ptr1 = faustModule.wasm_dsp_factory.readWasmDSPFactoryFromMachine2(dsp_bytes);
                console.log("factory_ptr1 " + factory_ptr);
                var instance_ptr1 = factory_ptr.createDSPInstance();
                console.log("instance_ptr1 " + instance_ptr);
                console.log("instance_ptr1 getNumInputs " + instance_ptr1.getNumInputs());
                console.log("instance_ptr1 getNumOutputs " + instance_ptr1.getNumOutputs());

                //console.log("faustModule.wasm_dsp_factory.createAudioBuffers " + faustModule.wasm_dsp_factory.createAudioBuffers);

                var js_inputs = faustModule.wasm_dsp_factory.createAudioBuffers(instance_ptr1.getNumInputs(), 256);
                var js_outputs = faustModule.wasm_dsp_factory.createAudioBuffers(instance_ptr1.getNumOutputs(), 256);

                //console.log("instance_ptr1.compute " + instance_ptr1.compute);

                instance_ptr1.compute(256, js_inputs, js_outputs);

                faustModule.wasm_dsp_factory.deleteAudioBuffers(js_inputs, instance_ptr1.getNumInputs());
                faustModule.wasm_dsp_factory.deleteAudioBuffers(js_outputs, instance_ptr1.getNumOutputs());

                //instance_ptr1.computeJSTest(128);
            });

            // End API test
            */

            if ($moduleCode === 0) return null;
            const $compiledCode = this.getWasmCModule($moduleCode);
            const compiledCodeSize = this.getWasmCModuleSize($moduleCode);

            // Copy native 'binary' string in JavaScript Uint8Array
            const ui8Code = new Uint8Array(compiledCodeSize);
            for (let i = 0; i < compiledCodeSize; i++) {
                // faster than 'getValue' which gets the type of access for each read...
                ui8Code[i] = this.libFaust.HEAP8[$compiledCode + i];
            }

            const $helpersCode = this.getWasmCHelpers($moduleCode);
            const helpersCode = this.libFaust.UTF8ToString($helpersCode);

            // Free strings
            this.libFaust._free($code);
            this.libFaust._free($name);
            this.libFaust._free($errorMsg);

            // Free C allocated wasm module
            this.freeWasmCModule($moduleCode);

            // Get an updated integer view on the newly allocated buffer after possible emscripten memory grow
            $argv_buffer = new Int32Array(this.libFaust.HEAP32.buffer, $argv, argvAux.length);
            // Free 'argv' C side array
            for (let i = 0; i < argvAux.length; i++) {
                this.libFaust._free($argv_buffer[i]);
            }
            this.libFaust._free($argv);

            return { ui8Code, code, helpersCode } as TCompiledCode;

        } catch (e) {
            // libfaust is compiled without C++ exception activated, so a JS exception is throwed and catched here
            let errorMsg = this.libFaust.UTF8ToString(this.getErrorAfterException());
            // Report the Emscripten error
            if (!errorMsg) errorMsg = e;
            this.cleanupAfterException();
            throw errorMsg;
        }
    }
    private async compileCodes(code: string, argv: string[], internalMemory: boolean) {
        // Code memory type and argv in the SHAKey to differentiate compilation flags and Monophonic and Polyphonic factories
        const strArgv = argv.join("");
        const shaKey = sha1.hash(code + (internalMemory ? "internal_memory" : "external_memory") + strArgv, { msgFormat: "string" });
        const compiledDsp = this.dspTable[shaKey];
        if (compiledDsp) {
            this.log("Existing library : " + compiledDsp.codes.dspName);
            // Existing factory, do not create it...
            return compiledDsp;
        }
        this.log("libfaust.js version : " + this.getLibFaustVersion());

        // Factory name for DSP and effect
        const dspName = "mydsp" + this.dspCount;
        const effectName = "effect" + this.dspCount++;

        // Create 'effect' expression
        const effectCode = `adapt(1,1) = _; adapt(2,2) = _,_; adapt(1,2) = _ <: _,_; adapt(2,1) = _,_ :> _;
adaptor(F,G) = adapt(outputs(F),inputs(G));
dsp_code = environment{${code}};
process = adaptor(dsp_code.process, dsp_code.effect) : dsp_code.effect;`;

        const dspCompiledCode = this.compileCode(dspName, code, argv, internalMemory);

        if (!dspCompiledCode) return null;
        let effectCompiledCode: TCompiledCode;
        try {
            effectCompiledCode = this.compileCode(effectName, effectCode, argv, internalMemory);
        } catch (e) {}
        const compiledCodes = { dspName, effectName, dsp: dspCompiledCode, effect: effectCompiledCode } as TCompiledCodes;
        return this.compileDsp(compiledCodes, shaKey);
    }
    private expandCode(code: string, argvIn: string[]) {
        this.log("libfaust.js version : " + this.getLibFaustVersion());
        // Allocate strings on the HEAP
        const codeSize = this.libFaust.lengthBytesUTF8(code) + 1;
        const $code = this.libFaust._malloc(codeSize);

        const name = "FaustDSP";
        const nameSize = this.libFaust.lengthBytesUTF8(name) + 1;
        const $name = this.libFaust._malloc(nameSize);

        const $shaKey = this.libFaust._malloc(64);
        const $errorMsg = this.libFaust._malloc(4096);

        this.libFaust.stringToUTF8(name, $name, nameSize);
        this.libFaust.stringToUTF8(code, $code, codeSize);

        const argv = argvIn || [];
        // Force "wasm" compilation
        argv.push("-lang");
        argv.push("wasm");

        // Prepare 'argv' array for C side
        const ptrSize = 4;
        const $argv = this.libFaust._malloc(argv.length * ptrSize);  // Get buffer from emscripten.
        let $argv_buffer = new Int32Array(this.libFaust.HEAP32.buffer, $argv, argv.length);  // Get a integer view on the newly allocated buffer.
        for (let i = 0; i < argv.length; i++) {
            const $arg_size = this.libFaust.lengthBytesUTF8(argv[i]) + 1;
            const $arg = this.libFaust._malloc($arg_size);
            this.libFaust.stringToUTF8(argv[i], $arg, $arg_size);
            $argv_buffer[i] = $arg;
        }
        try {
            const $expandedCode = this.expandCDSPFromString($name, $code, argv.length, $argv, $shaKey, $errorMsg);
            const expandedCode = this.libFaust.UTF8ToString($expandedCode);
            const shaKey = this.libFaust.UTF8ToString($shaKey);
            const errorMsg = this.libFaust.UTF8ToString($errorMsg);
            if (errorMsg) this.error(errorMsg);
            // Free strings
            this.libFaust._free($code);
            this.libFaust._free($name);
            this.libFaust._free($shaKey);
            this.libFaust._free($errorMsg);
            // Free C allocated expanded string
            this.freeCMemory($expandedCode);
            // Get an updated integer view on the newly allocated buffer after possible emscripten memory grow
            $argv_buffer = new Int32Array(this.libFaust.HEAP32.buffer, $argv, argv.length);
            // Free 'argv' C side array
            for (let i = 0; i < argv.length; i++) {
                this.libFaust._free($argv_buffer[i]);
            }
            this.libFaust._free($argv);
            return expandedCode;
        } catch (e) {
            // libfaust is compiled without C++ exception activated, so a JS exception is throwed and catched here
            let errorMsg = this.libFaust.UTF8ToString(this.getErrorAfterException());
            // Report the Emscripten error
            if (!errorMsg) errorMsg = e;
            this.cleanupAfterException();
            throw errorMsg;
        }
    }
    private async compileDsp(codes: TCompiledCodes, shaKey: string) {
        const time1 = performance.now();
        /*
        if (typeof Binaryen !== "undefined") {
            try {
                const binaryenModule = Binaryen.readBinary(codes.dsp.ui8Code);
                this.log("Binaryen based optimisation");
                binaryenModule.optimize();
                // console.log(binaryen_module.emitText());
                codes.dsp.ui8Code = binaryenModule.emitBinary();
                binaryenModule.dispose();
            } catch (e) {
                this.log("Binaryen not available, no optimisation...");
            }
        }
        */
        const dspModule = await WebAssembly.compile(codes.dsp.ui8Code);
        if (!dspModule) return this.error("Faust DSP factory cannot be compiled");
        const time2 = performance.now();
        this.log("WASM compilation duration : " + (time2 - time1));
        const compiledDsp = { shaKey, codes, dspModule, polyphony: [] as number[] } as TCompiledDsp; // Default mode
        // 'libfaust.js' wasm backend generates UI methods, then we compile the code
        // eval(helpers_code1);
        // factory.getJSON = eval("getJSON" + dspName);
        // factory.getBase64Code = eval("getBase64Code" + dspName);
        try {
            const json = codes.dsp.helpersCode.match(/getJSON\w+?\(\)[\s\n]*{[\s\n]*return[\s\n]*'(\{.+?)';}/)[1];
            const base64Code = codes.dsp.helpersCode.match(/getBase64Code\w+?\(\)[\s\n]*{[\s\n]*return[\s\n]*"([A-Za-z0-9+/=]+?)";[\s\n]+}/)[1];
            const meta = JSON.parse(json);
            compiledDsp.dspHelpers = { json, base64Code, meta };
        } catch (e) {
            this.error("Error in JSON.parse: " + e);
            throw e;
        }
        this.dspTable[shaKey] = compiledDsp;
        // Possibly compile effect
        if (!codes.effectName || !codes.effect) return compiledDsp;
        try {
            const effectModule = await WebAssembly.compile(codes.effect.ui8Code);
            compiledDsp.effectModule = effectModule;
            // 'libfaust.js' wasm backend generates UI methods, then we compile the code
            // eval(helpers_code2);
            // factory.getJSONeffect = eval("getJSON" + factory_name2);
            // factory.getBase64Codeeffect = eval("getBase64Code" + factory_name2);
            try {
                const json = codes.effect.helpersCode.match(/getJSON\w+?\(\)[\s\n]*{[\s\n]*return[\s\n]*'(\{.+?)';}/)[1];
                const base64Code = codes.effect.helpersCode.match(/getBase64Code\w+?\(\)[\s\n]*{[\s\n]*return[\s\n]*"([A-Za-z0-9+/=]+?)";[\s\n]+}/)[1];
                const meta = JSON.parse(json);
                compiledDsp.effectHelpers = { json, base64Code, meta };
            } catch (e) {
                this.error("Error in JSON.parse: " + e);
                throw e;
            }
        } catch (e) {
            return compiledDsp;
        }
    }
    private async getScriptProcessorNode(compiledDsp: TCompiledDsp, audioCtx: AudioContext, bufferSize?: number, voices?: number) {
        return await new FaustWasmToScriptProcessor(this).getNode(compiledDsp, audioCtx, bufferSize, voices);
    }
    // deleteDSPInstance() {}
    private async getAudioWorkletNode(compiledDsp: TCompiledDsp, audioCtx: AudioContext, bufferSize?: number, voices?: number) {
        if (compiledDsp.polyphony.indexOf(voices) === -1) {
            const strProcessor = `
const faustData = ${JSON.stringify({
    bufferSize,
    voices,
    name: compiledDsp.codes.dspName,
    dspMeta: compiledDsp.dspHelpers.meta,
    dspBase64Code: compiledDsp.dspHelpers.base64Code,
    effectMeta: compiledDsp.effectHelpers ? compiledDsp.effectHelpers.meta : undefined,
    effectBase64Code: compiledDsp.effectHelpers ? compiledDsp.effectHelpers.base64Code : undefined,
    mixerBase64Code: mixer32Base64Code
} as FaustData)};
(${FaustAudioWorkletProcessorWrapper.toString()})();
`;
            const url = window.URL.createObjectURL(new Blob([strProcessor], { type: "text/javascript" }));
            await audioCtx.audioWorklet.addModule(url);
            compiledDsp.polyphony.push(voices || 1);
        }
        return new FaustAudioWorkletNode(audioCtx, compiledDsp);
    }
    private deleteDsp(compiledDsp: TCompiledDsp) {
        // The JS side is cleared
        delete this.dspTable[compiledDsp.shaKey];
        // The native C++ is cleared each time (freeWasmCModule has been already called in faust.compile)
        this.deleteAllWasmCDSPFactories();
    }
    private getCompiledCodesForMachine(compiledCodes: TCompiledCodes) {
        return {
            dspName: compiledCodes.dspName,
            dsp: {
                strCode: ab2str(compiledCodes.dsp.ui8Code),
                code: compiledCodes.dsp.code,
                helpersCode: compiledCodes.dsp.helpersCode
            },
            effectName : compiledCodes.effectName,
            effect: {
                strCode: ab2str(compiledCodes.effect.ui8Code),
                code: compiledCodes.effect.code,
                helpersCode: compiledCodes.effect.helpersCode
            }
        } as TCompiledStrCodes;
    }
    private async getCompiledCodeFromMachine(compiledStrCodes: TCompiledStrCodes) {
        const shaKey = sha1.hash(compiledStrCodes.dsp.code, { msgFormat: "string" });
        const compiledDsp = this.dspTable[shaKey];
        if (compiledDsp) {
            this.log("Existing library : " + compiledDsp.codes.dspName);
            // Existing factory, do not create it...
            return compiledDsp;
        }
        const compiledCodes = {
            dspName: compiledStrCodes.dspName,
            effectName: compiledStrCodes.effectName,
            dsp: {
                ui8Code: str2ab(compiledStrCodes.dsp.strCode),
                code: compiledStrCodes.dsp.code,
                helpersCode: compiledStrCodes.dsp.helpersCode
            },
            effect: {
                ui8Code: str2ab(compiledStrCodes.effect.strCode),
                code: compiledStrCodes.effect.code,
                helpersCode: compiledStrCodes.effect.helpersCode
            }
        } as TCompiledCodes;
        return this.compileDsp(compiledCodes, shaKey);
    }
    // deleteDSPWorkletInstance() {}
    log(...args: any[]) {
        if (this.debug) console.log(...args);
        this._log.push(JSON.stringify(args));
    }
    error(...args: any[]) {
        console.error(...args);
        this._log.push(JSON.stringify(args));
    }
}
if (typeof module === "undefined" || typeof module.exports === "undefined") window.Faust = Faust;
