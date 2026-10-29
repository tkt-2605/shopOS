/// Which program holds a port, for a message a person can act on.
///
/// Windows has no way to set a port aside for one program: whoever binds it
/// first has it. So when the till cannot have its port, the useful thing is to
/// say who does -- "port 7802 is held by OtherApp.exe (pid 4120)" -- rather
/// than "address in use", which sends somebody hunting. One-time setup that
/// makes this rare is `tools/windows/setup-ports.ps1`.
///
/// Read from `netstat -ano` and `tasklist`, both in every Windows. Never fails:
/// anything it cannot read is `None`, and the message simply leaves it out.
use std::process::Command;

/// `"OtherApp.exe (pid 4120)"`, or `None` when nobody holds it or it cannot be told.
pub fn holder(port: u16, udp: bool) -> Option<String> {
    let pid = owner_pid(port, udp)?;
    let name = process_name(pid).unwrap_or_else(|| "a program".to_string());
    Some(format!("{name} (pid {pid})"))
}

/// " Port 7802 is held by OtherApp.exe (pid 4120)." or "" -- to put after an error.
pub fn held_by(port: u16, udp: bool) -> String {
    match holder(port, udp) {
        Some(who) => format!(" Port {port} is held by {who}."),
        None => String::new(),
    }
}

fn owner_pid(port: u16, udp: bool) -> Option<u32> {
    let text = run("netstat", &["-ano", "-p", if udp { "UDP" } else { "TCP" }])?;
    pid_on(&text, port, udp)
}

/// The pid listening on `port` in `netstat -ano` output. UDP rows have no state.
fn pid_on(text: &str, port: u16, udp: bool) -> Option<u32> {
    let suffix = format!(":{port}");
    text.lines().find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (local, pid) = match (udp, cols.as_slice()) {
            (false, [_, local, _, "LISTENING", pid]) => (*local, *pid),
            (true, [_, local, _, pid]) => (*local, *pid),
            _ => return None,
        };
        if local.ends_with(&suffix) { pid.parse().ok().filter(|p| *p != 0) } else { None }
    })
}

fn process_name(pid: u32) -> Option<String> {
    let text = run("tasklist", &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])?;
    let first = text.lines().next()?.split("\",\"").next()?.trim_matches('"').to_string();
    if first.is_empty() || first.starts_with("INFO:") { None } else { Some(first) }
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::pid_on;

    const TCP: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:7801           0.0.0.0:0              LISTENING       27636
  TCP    127.0.0.1:7802         0.0.0.0:0              LISTENING       27637
  TCP    127.0.0.1:7802         127.0.0.1:57441        TIME_WAIT       0
  TCP    [::]:17801             [::]:0                 LISTENING       9
";
    const UDP: &str = "
  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:7802           *:*                                    27636
";

    #[test]
    fn finds_the_listener_and_not_a_lookalike_port() {
        assert_eq!(pid_on(TCP, 7801, false), Some(27636));
        assert_eq!(pid_on(TCP, 7802, false), Some(27637));
        assert_eq!(pid_on(TCP, 1780, false), None);
        assert_eq!(pid_on(UDP, 7802, true), Some(27636));
        assert_eq!(pid_on(UDP, 7801, true), None);
    }
}
