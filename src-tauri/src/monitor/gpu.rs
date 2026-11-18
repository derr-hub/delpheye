//! Graphics card stress and integrity test through Direct3D 11 compute shaders — present on every
//! Windows machine and every GPU maker, so it needs no extra runtime.
//!
//! Each round it
//! - fills most of the free video memory with a pattern and reads every word back (a VRAM test),
//! - runs a long, data-dependent integer computation and checks samples of the result against
//!   the same computation done on the CPU (a compute test, and the bulk of the load).
//! Any mismatch is a hardware error: unstable overclock, overheating memory, a failing card.
//!
//! Every dispatch is kept well under Windows' two-second GPU timeout; a driver reset during the
//! test is itself reported.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_UNORDERED_ACCESS, D3D11_BUFFER_DESC, D3D11_BUFFER_UAV, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG,
    D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_RESOURCE_MISC_BUFFER_STRUCTURED, D3D11_SDK_VERSION, D3D11_UAV_DIMENSION_BUFFER,
    D3D11_UNORDERED_ACCESS_VIEW_DESC, D3D11_UNORDERED_ACCESS_VIEW_DESC_0, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Buffer,
    ID3D11ComputeShader, ID3D11Device, ID3D11DeviceContext, ID3D11UnorderedAccessView,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_UNKNOWN;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter1, IDXGIAdapter3, IDXGIFactory1};
use windows::core::{Interface, PCSTR, s};

const SHADER: &str = r#"
RWStructuredBuffer<uint> data : register(u0);
RWStructuredBuffer<uint> result : register(u1);
cbuffer Params : register(b0) { uint seed; uint count; uint iterations; uint pad; };
uint mixer(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
uint at(uint3 id) { return id.y * 16776960u + id.x; }
[numthreads(256, 1, 1)] void fill(uint3 id : SV_DispatchThreadID) { uint i = at(id); if (i < count) data[i] = mixer(i ^ seed); }
[numthreads(256, 1, 1)] void check(uint3 id : SV_DispatchThreadID) { uint i = at(id); if (i < count && data[i] != mixer(i ^ seed)) InterlockedAdd(result[0], 1u); }
[numthreads(256, 1, 1)] void crunch(uint3 id : SV_DispatchThreadID) {
    uint i = at(id); if (i >= count) return;
    uint x = i ^ seed;
    for (uint k = 0; k < iterations; k++) { x = mixer(x + k); }
    data[i] = x;
}
"#;

/// The same mixing function the shader uses, for checking its answers.
fn mixer(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

fn crunch_expected(i: u32, seed: u32, iterations: u32) -> u32 {
    let mut x = i ^ seed;
    for k in 0..iterations {
        x = mixer(x.wrapping_add(k));
    }
    x
}

/// Words per video-memory block (128 MB): within Direct3D 11's limit for one buffer.
const BLOCK: u32 = 32 * 1024 * 1024;
/// Words the compute load works on.
const CRUNCH: u32 = 1 << 20;
/// Compute dispatch length to aim for, in milliseconds.
const TARGET_MS: f64 = 120.0;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    /// Dedicated video memory in bytes; small for integrated graphics.
    pub vram: u64,
    pub integrated: bool,
}

fn adapter(index: u32) -> Option<IDXGIAdapter1> {
    // SAFETY: plain COM calls; the factory and adapter are reference-counted by the bindings.
    unsafe { CreateDXGIFactory1::<IDXGIFactory1>().ok()?.EnumAdapters1(index).ok() }
}

/// Every hardware graphics adapter, discrete cards first.
pub fn adapters() -> Vec<GpuInfo> {
    let mut out = Vec::new();
    for index in 0..16 {
        let Some(a) = adapter(index) else { break };
        // SAFETY: GetDesc1 fills a plain struct.
        let Ok(desc) = (unsafe { a.GetDesc1() }) else { continue };
        // Skip the Microsoft Basic Render Driver (software).
        if desc.Flags & 2 != 0 || desc.VendorId == 0x1414 {
            continue;
        }
        let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(128);
        let vram = desc.DedicatedVideoMemory as u64;
        out.push(GpuInfo { index, name: String::from_utf16_lossy(&desc.Description[..len]).trim().to_string(), vram, integrated: vram < 1024 * 1024 * 1024 });
    }
    out.sort_by(|a, b| a.integrated.cmp(&b.integrated).then(b.vram.cmp(&a.vram)));
    out
}

#[derive(Default)]
pub struct GpuStats {
    pub rounds: AtomicU64,
    pub compute_errors: AtomicU64,
    pub vram_errors: AtomicU64,
    /// Video memory currently under test, in bytes.
    pub tested_bytes: AtomicU64,
    /// The driver reset or removed the device during the test.
    pub lost: AtomicBool,
    /// Why the test could not run, if it could not.
    pub problem: Mutex<Option<String>>,
    pub name: Mutex<String>,
}

struct Gpu {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    fill: ID3D11ComputeShader,
    check: ID3D11ComputeShader,
    crunch: ID3D11ComputeShader,
    params: ID3D11Buffer,
}

fn compile(device: &ID3D11Device, entry: PCSTR) -> windows::core::Result<ID3D11ComputeShader> {
    let mut code: Option<ID3DBlob> = None;
    // SAFETY: the source outlives the call; the blob holds the bytecode we copy out of it.
    unsafe {
        D3DCompile(SHADER.as_ptr().cast(), SHADER.len(), s!("delpheye"), None, None, entry, s!("cs_5_0"), 1 << 15, 0, &mut code, None)?;
        let code = code.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        let bytes = std::slice::from_raw_parts(code.GetBufferPointer() as *const u8, code.GetBufferSize());
        let mut shader = None;
        device.CreateComputeShader(bytes, None, Some(&mut shader))?;
        Ok(shader.unwrap())
    }
}

fn buffer(device: &ID3D11Device, words: u32, staging: bool) -> windows::core::Result<ID3D11Buffer> {
    let desc = D3D11_BUFFER_DESC {
        ByteWidth: words * 4,
        Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
        BindFlags: if staging { 0 } else { D3D11_BIND_UNORDERED_ACCESS.0 as u32 },
        CPUAccessFlags: if staging { D3D11_CPU_ACCESS_READ.0 as u32 } else { 0 },
        MiscFlags: if staging { 0 } else { D3D11_RESOURCE_MISC_BUFFER_STRUCTURED.0 as u32 },
        StructureByteStride: if staging { 0 } else { 4 },
    };
    let mut out = None;
    // SAFETY: the description is complete; no initial data.
    unsafe { device.CreateBuffer(&desc, None, Some(&mut out))? };
    Ok(out.unwrap())
}

fn view(device: &ID3D11Device, buffer: &ID3D11Buffer, words: u32) -> windows::core::Result<ID3D11UnorderedAccessView> {
    let desc = D3D11_UNORDERED_ACCESS_VIEW_DESC {
        Format: DXGI_FORMAT_UNKNOWN,
        ViewDimension: D3D11_UAV_DIMENSION_BUFFER,
        Anonymous: D3D11_UNORDERED_ACCESS_VIEW_DESC_0 { Buffer: D3D11_BUFFER_UAV { FirstElement: 0, NumElements: words, Flags: 0 } },
    };
    let mut out = None;
    // SAFETY: the view describes the whole structured buffer it is made for.
    unsafe { device.CreateUnorderedAccessView(buffer, Some(&desc), Some(&mut out))? };
    Ok(out.unwrap())
}

impl Gpu {
    fn open(index: u32) -> Result<(Self, IDXGIAdapter1), String> {
        let adapter = adapter(index).ok_or("no-adapter")?;
        let (mut device, mut ctx) = (None, None);
        // SAFETY: standard device creation on a chosen adapter.
        unsafe {
            D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_FLAG(0), Some(&[D3D_FEATURE_LEVEL_11_0]), D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx))
                .map_err(|e| format!("device: {e}"))?;
        }
        let (device, ctx) = (device.ok_or("device")?, ctx.ok_or("context")?);
        let params = {
            let desc = D3D11_BUFFER_DESC { ByteWidth: 16, Usage: D3D11_USAGE_DEFAULT, BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32, ..Default::default() };
            let mut out = None;
            // SAFETY: a 16-byte constant buffer.
            unsafe { device.CreateBuffer(&desc, None, Some(&mut out)).map_err(|e| format!("params: {e}"))? };
            out.unwrap()
        };
        let gpu = Gpu {
            fill: compile(&device, s!("fill")).map_err(|e| format!("shader: {e}"))?,
            check: compile(&device, s!("check")).map_err(|e| format!("shader: {e}"))?,
            crunch: compile(&device, s!("crunch")).map_err(|e| format!("shader: {e}"))?,
            device,
            ctx,
            params,
        };
        Ok((gpu, adapter))
    }

    /// Runs `shader` over `count` words of `data`, with `result` as the error counter.
    fn run(&self, shader: &ID3D11ComputeShader, data: &ID3D11UnorderedAccessView, result: &ID3D11UnorderedAccessView, seed: u32, count: u32, iterations: u32) {
        let params = [seed, count, iterations, 0u32];
        let groups = count.div_ceil(256);
        let (x, y) = (groups.min(65_535), groups.div_ceil(65_535));
        let views = [Some(data.clone()), Some(result.clone())];
        // SAFETY: every bound object is alive for the call; the parameter block is 16 bytes.
        unsafe {
            self.ctx.UpdateSubresource(&self.params, 0, None, params.as_ptr().cast(), 0, 0);
            self.ctx.CSSetShader(shader, None);
            self.ctx.CSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));
            self.ctx.CSSetUnorderedAccessViews(0, 2, Some(views.as_ptr()), None);
            self.ctx.Dispatch(x, y, 1);
        }
    }

    /// Copies a buffer to a readable one and returns its words; waits for the GPU to finish.
    fn read(&self, source: &ID3D11Buffer, staging: &ID3D11Buffer, words: usize) -> Option<Vec<u32>> {
        // SAFETY: the staging buffer is at least `words` long; the mapping is released before returning.
        unsafe {
            self.ctx.CopyResource(staging, source);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ok()?;
            let out = std::slice::from_raw_parts(mapped.pData as *const u32, words).to_vec();
            self.ctx.Unmap(staging, 0);
            Some(out)
        }
    }

    fn removed(&self) -> bool {
        // SAFETY: a status query.
        unsafe { self.device.GetDeviceRemovedReason().is_err() }
    }
}

/// How much video memory to test: most of what is free right now, never the last of it.
fn budget(adapter: &IDXGIAdapter1, integrated: bool) -> u64 {
    let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
    // SAFETY: a plain query into a local struct.
    let free = unsafe { adapter.cast::<IDXGIAdapter3>().and_then(|a| a.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)) }
        .map(|_| info.Budget.saturating_sub(info.CurrentUsage))
        .unwrap_or(512 * 1024 * 1024);
    let target = (free as f64 * 0.85) as u64;
    // Integrated graphics borrows system memory; the RAM test covers that.
    if integrated { target.min(1024 * 1024 * 1024) } else { target }
}

/// Starts the test on adapter `index` in its own thread; it runs until `stop` is set.
pub fn start(index: u32, stop: Arc<AtomicBool>, stats: Arc<GpuStats>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let fail = |why: String| *stats.problem.lock().unwrap() = Some(why);
        let info = adapters().into_iter().find(|a| a.index == index);
        *stats.name.lock().unwrap() = info.as_ref().map(|i| i.name.clone()).unwrap_or_default();
        let (gpu, adapter) = match Gpu::open(index) {
            Ok(v) => v,
            Err(e) => return fail(e),
        };
        let setup = || -> windows::core::Result<_> {
            let result = buffer(&gpu.device, 4, false)?;
            let result_view = view(&gpu.device, &result, 4)?;
            let result_read = buffer(&gpu.device, 4, true)?;
            let crunch = buffer(&gpu.device, CRUNCH, false)?;
            let crunch_view = view(&gpu.device, &crunch, CRUNCH)?;
            let crunch_read = buffer(&gpu.device, CRUNCH, true)?;
            Ok((result, result_view, result_read, crunch, crunch_view, crunch_read))
        };
        let (result, result_view, result_read, crunch, crunch_view, crunch_read) = match setup() {
            Ok(v) => v,
            Err(e) => return fail(format!("buffers: {e}")),
        };

        // Video memory blocks, as many as fit the budget.
        let target = budget(&adapter, info.as_ref().is_some_and(|i| i.integrated));
        let mut blocks: Vec<(ID3D11Buffer, ID3D11UnorderedAccessView)> = Vec::new();
        while (blocks.len() as u64 + 1) * BLOCK as u64 * 4 <= target && !stop.load(Ordering::Relaxed) {
            match buffer(&gpu.device, BLOCK, false).and_then(|b| view(&gpu.device, &b, BLOCK).map(|v| (b, v))) {
                Ok(block) => blocks.push(block),
                Err(_) => break,
            }
        }
        stats.tested_bytes.store(blocks.len() as u64 * BLOCK as u64 * 4, Ordering::Relaxed);

        let zero = [0u32; 4];
        let mut iterations: u32 = 1024;
        let mut round: u32 = 0;
        while !stop.load(Ordering::Relaxed) {
            let seed = mixer(round.wrapping_mul(0x9E37_79B9) ^ 0xD31F_0E7E);
            // SAFETY: clearing the error counter the check kernel adds to.
            unsafe { gpu.ctx.ClearUnorderedAccessViewUint(&result_view, &zero) };
            for (n, (_, v)) in blocks.iter().enumerate() {
                gpu.run(&gpu.fill, v, &result_view, seed ^ n as u32, BLOCK, 0);
            }
            for (n, (_, v)) in blocks.iter().enumerate() {
                gpu.run(&gpu.check, v, &result_view, seed ^ n as u32, BLOCK, 0);
            }
            let started = Instant::now();
            gpu.run(&gpu.crunch, &crunch_view, &result_view, seed, CRUNCH, iterations);
            let Some(answers) = gpu.read(&crunch, &crunch_read, CRUNCH as usize) else {
                stats.lost.store(gpu.removed(), Ordering::Relaxed);
                if gpu.removed() { break } else { continue }
            };
            let took = started.elapsed().as_secs_f64() * 1000.0;
            let errors = gpu.read(&result, &result_read, 1).map_or(0, |r| r[0] as u64);
            stats.vram_errors.fetch_add(errors, Ordering::Relaxed);
            // Spot-check the compute results on the CPU: 32 words spread over the buffer.
            let wrong = (0..32u32).map(|k| (k * 32_749 + round) % CRUNCH).filter(|&i| answers[i as usize] != crunch_expected(i, seed, iterations)).count();
            stats.compute_errors.fetch_add(wrong as u64, Ordering::Relaxed);
            stats.rounds.fetch_add(1, Ordering::Relaxed);
            if gpu.removed() {
                stats.lost.store(true, Ordering::Relaxed);
                break;
            }
            // Keep the compute dispatch near its target length: heavy, but far from the timeout.
            if took > 1.0 {
                iterations = ((iterations as f64 * TARGET_MS / took) as u32).clamp(64, 1 << 15);
            }
            round = round.wrapping_add(1);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cpu_copy_of_the_mixer_is_stable() {
        assert_eq!(mixer(0), 0);
        assert_ne!(mixer(1), mixer(2));
        assert_eq!(crunch_expected(5, 7, 0), 5 ^ 7);
    }

    /// Runs the real test on the first graphics adapter for a few seconds. Needs a GPU.
    #[test]
    #[ignore]
    fn gpu_runs_clean() {
        let list = adapters();
        eprintln!("{list:?}");
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(GpuStats::default());
        let handle = start(list[0].index, stop.clone(), stats.clone());
        std::thread::sleep(std::time::Duration::from_secs(8));
        stop.store(true, Ordering::Relaxed);
        handle.join().unwrap();
        eprintln!(
            "problem={:?} rounds={} vram={} MB compute_errors={} vram_errors={}",
            stats.problem.lock().unwrap(),
            stats.rounds.load(Ordering::Relaxed),
            stats.tested_bytes.load(Ordering::Relaxed) / 1_048_576,
            stats.compute_errors.load(Ordering::Relaxed),
            stats.vram_errors.load(Ordering::Relaxed)
        );
        assert!(stats.problem.lock().unwrap().is_none());
        assert!(stats.rounds.load(Ordering::Relaxed) > 0);
        assert_eq!(stats.compute_errors.load(Ordering::Relaxed) + stats.vram_errors.load(Ordering::Relaxed), 0);
    }
}
