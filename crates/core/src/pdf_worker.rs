//! PDF parsing is deliberately isolated: compressed streams can expand far beyond input size.
use anyhow::{bail, Context, Result};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{mpsc, OnceLock},
    time::{Duration, Instant},
};
static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
pub const MAX_TEXT: usize = 8 * 1024 * 1024;
const MEMORY_LIMIT: usize = 768 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);
pub fn configure(path: PathBuf) {
    let _ = EXECUTABLE.set(path);
}

pub fn parse(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    let exe = EXECUTABLE
        .get()
        .context("No está configurado el lector aislado de PDF")?;
    if bytes.len() > crate::import::MAX_FILE {
        bail!("El límite por archivo es 20 MB");
    }
    let mut command = Command::new(exe);
    command
        .arg("--lupino-parse-pdf")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                for (resource, limit) in [
                    // Darwin rejects RLIMIT_AS. Its worker is monitored by RSS below.
                    #[cfg(not(target_os = "macos"))]
                    (libc::RLIMIT_AS, MEMORY_LIMIT as libc::rlim_t),
                    (libc::RLIMIT_CPU, 10),
                    (libc::RLIMIT_CORE, 0),
                ] {
                    let limits = libc::rlimit {
                        rlim_cur: limit,
                        rlim_max: limit,
                    };
                    if libc::setrlimit(resource, &limits) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .context("No se pudo iniciar el lector de PDF")?;
    #[cfg(windows)]
    let _job = match WindowsJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let mut stdin = child.stdin.take().context("Falta el canal del PDF")?;
    let stdout = child.stdout.take().context("Falta el resultado del PDF")?;
    let input = bytes.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout
            .take((MAX_TEXT * 2 + 1) as u64)
            .read_to_end(&mut output)
            .map(|_| output);
        let _ = sender.send(result);
    });
    let start = Instant::now();
    let response = (|| -> Result<std::io::Result<Vec<u8>>> {
        loop {
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(output) => return Ok(output),
                Err(mpsc::RecvTimeoutError::Disconnected) => bail!("El lector de PDF se cerró sin resultado"),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if start.elapsed() >= DEADLINE { bail!("El PDF superó el tiempo máximo de lectura"); }
                    #[cfg(target_os = "macos")]
                    if resident_memory(child.id()).is_some_and(|bytes| bytes > MEMORY_LIMIT as u64) {
                        bail!("El PDF superó el límite de memoria");
                    }
                }
            }
        }
    })();
    let result = (|| -> Result<Vec<(String, String)>> {
        let output = response.context("El PDF superó el tiempo máximo de lectura")??;
        if output.len() > MAX_TEXT * 2 {
            bail!("El texto del PDF supera el límite de lectura");
        }
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    bail!("El PDF no pudo leerse dentro del límite de memoria/tiempo");
                }
                break;
            }
            if start.elapsed() > DEADLINE {
                bail!("El PDF superó el tiempo máximo de lectura");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let value: serde_json::Value = serde_json::from_slice(&output)
            .context("El lector de PDF no pudo completar el archivo")?;
        if let Some(error) = value["error"].as_str() {
            bail!("{error}");
        }
        let sections: Vec<(String, String)> = serde_json::from_value(value["sections"].clone())?;
        if sections.iter().map(|(_, text)| text.len()).sum::<usize>() > MAX_TEXT {
            bail!("El texto del PDF supera el límite de lectura");
        }
        Ok(sections)
    })();
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = writer.join();
    let _ = reader.join();
    result
}

#[cfg(target_os = "macos")]
fn resident_memory(pid: u32) -> Option<u64> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as libc::c_int;
    let read = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), size) };
    (read == size).then_some(info.pti_resident_size)
}

/// Called before any GUI/runtime initialization, with inherited OS resource limits.
pub fn run() -> Result<()> {
    let result = (|| -> Result<Vec<(String, String)>> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take((crate::import::MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > crate::import::MAX_FILE {
            bail!("El límite por archivo es 20 MB");
        }
        let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)?;
        if pages.len() > 5000 || pages.iter().map(String::len).sum::<usize>() > MAX_TEXT {
            bail!("El PDF supera el límite de 8 MB de texto o 5.000 páginas");
        }
        Ok(pages
            .into_iter()
            .enumerate()
            .map(|(i, text)| (format!("Página {}", i + 1), text))
            .collect())
    })();
    let value = match result {
        Ok(sections) => serde_json::json!({"sections":sections}),
        Err(error) => serde_json::json!({"error":error.to_string()}),
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.flush()?;
    Ok(())
}

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_PROCESS_TIME
                | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            limits.BasicLimitInformation.PerProcessUserTimeLimit = 10 * 10_000_000;
            limits.ProcessMemoryLimit = MEMORY_LIMIT;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
