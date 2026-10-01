use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Windows Open With passes the filename as an argument after the executable.
/// Resolve relative paths against the launching process, without touching media.
pub fn video_path(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
    let mut literal = false;
    for argument in args.into_iter().skip(1) {
        if argument == "--" {
            literal = true;
            continue;
        }
        if argument.is_empty() || (!literal && argument.to_string_lossy().starts_with('-')) {
            continue;
        }
        let path = PathBuf::from(argument);
        return Some(if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn ordinary_launch_has_no_video() {
        assert_eq!(
            video_path(args(&["quickcut.exe"]), &std::env::temp_dir()),
            None
        );
    }

    #[test]
    fn absolute_path_keeps_spaces_apostrophes_and_unicode() {
        let path = std::env::temp_dir().join("Sam's holiday – 日本語 video.mp4");
        let args = vec![
            OsString::from("quickcut.exe"),
            path.clone().into_os_string(),
        ];
        assert_eq!(video_path(args, Path::new("other-directory")), Some(path));
    }

    #[test]
    fn relative_path_uses_the_callers_directory() {
        let cwd = std::env::temp_dir().join("caller");
        assert_eq!(
            video_path(args(&["quickcut.exe", "clips/take one.MOV"]), &cwd),
            Some(cwd.join("clips/take one.MOV"))
        );
    }

    #[test]
    fn argument_separator_allows_dash_prefixed_filenames() {
        let cwd = std::env::temp_dir();
        assert_eq!(
            video_path(args(&["quickcut.exe", "--", "-take.mp4"]), &cwd),
            Some(cwd.join("-take.mp4"))
        );
        assert_eq!(video_path(args(&["quickcut.exe", "--help"]), &cwd), None);
    }

    #[test]
    fn a_single_source_is_opened_from_multiple_arguments() {
        let cwd = std::env::temp_dir();
        assert_eq!(
            video_path(args(&["quickcut.exe", "one.mp4", "two.mp4"]), &cwd),
            Some(cwd.join("one.mp4"))
        );
    }
}
