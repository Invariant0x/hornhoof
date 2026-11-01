import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from datetime import datetime, timezone

MAX_FRAME = 49152
CHUNK = 32768
ROOT_FD = 3
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class Failure(Exception):
    def __init__(self, reason):
        self.reason = reason


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def signature(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def inode(value):
    return value.st_dev, value.st_ino


def require_object(value, allowed):
    if not isinstance(value, dict) or set(value) != allowed:
        raise Failure("io_failed")


def require_text(value, pattern=None, maximum=1024):
    if not isinstance(value, str) or not value or len(value) > maximum or "\0" in value:
        raise Failure("unsafe_path")
    if pattern and not pattern.fullmatch(value):
        raise Failure("unsafe_path")
    return value


def require_size(value):
    if type(value) is not int or value < 0 or value > 9007199254740991:
        raise Failure("size_mismatch")
    return value


def require_digest(value):
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise Failure("hash_mismatch")
    return value


def components(relative):
    relative = require_text(relative)
    if relative.startswith("/"):
        raise Failure("unsafe_path")
    parts = relative.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise Failure("unsafe_path")
    return parts


def open_dir(parent, name):
    try:
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    except OSError:
        raise Failure("unsafe_path")


def open_parent(workspace_fd, parts):
    current = os.dup(workspace_fd)
    try:
        for part in parts:
            following = open_dir(current, part)
            os.close(current)
            current = following
        return current
    except Exception:
        os.close(current)
        raise


def open_path(parent, name):
    try:
        return os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
    except OSError:
        raise Failure("unsafe_path")


def read_fd(path_fd):
    try:
        fd = os.open(f"/proc/self/fd/{path_fd}", os.O_RDONLY)
    except OSError:
        raise Failure("io_failed")
    if inode(os.fstat(fd)) != inode(os.fstat(path_fd)):
        os.close(fd)
        raise Failure("source_changed")
    return fd


def hash_open_fd(fd):
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        while True:
            data = os.read(fd, CHUNK)
            if not data:
                return size, digest.hexdigest()
            size += len(data)
            digest.update(data)
    except OSError:
        raise Failure("io_failed")


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except OSError:
            raise Failure("io_failed")
        if written <= 0:
            raise Failure("io_failed")
        view = view[written:]


class Helper:
    def __init__(self):
        self.role = None
        self.agent_id = None
        self.workspace_fd = None
        self.workspace_identity = None
        self.expected_size = None
        self.expected_sha256 = None
        self.relative = None
        self.parent_parts = None
        self.basename = None
        self.source_path_fd = None
        self.source_fd = None
        self.source_signature = None
        self.parent_identity = None
        self.offset = 0
        self.stream_hash = None
        self.temp_fd = None
        self.verified_at = None
        self.published = False

    def workspace(self, agent_id):
        self.agent_id = require_text(agent_id, UUID, 36)
        self.workspace_fd = open_dir(ROOT_FD, self.agent_id)
        value = os.fstat(self.workspace_fd)
        self.workspace_identity = inode(value)
        self.workspace_owner = value.st_uid, value.st_gid
        self.check_workspace()

    def check_workspace(self):
        try:
            value = os.stat(self.agent_id, dir_fd=ROOT_FD, follow_symlinks=False)
        except OSError:
            raise Failure("unsafe_path")
        if not stat.S_ISDIR(value.st_mode) or inode(value) != self.workspace_identity:
            raise Failure("unsafe_path")
        if inode(os.fstat(self.workspace_fd)) != self.workspace_identity:
            raise Failure("unsafe_path")

    def open_source(self, request):
        require_object(request, {"op", "agentId", "relativePath", "expectedSize", "expectedSha256"})
        if self.role is not None:
            raise Failure("io_failed")
        self.role = "source"
        self.expected_size = require_size(request["expectedSize"])
        self.expected_sha256 = require_digest(request["expectedSha256"])
        parts = components(request["relativePath"])
        self.relative = request["relativePath"]
        self.parent_parts = parts[:-1]
        self.basename = parts[-1]
        self.workspace(request["agentId"])
        parent = open_parent(self.workspace_fd, self.parent_parts)
        try:
            self.parent_identity = inode(os.fstat(parent))
            self.source_path_fd = open_path(parent, self.basename)
            value = os.fstat(self.source_path_fd)
            if not stat.S_ISREG(value.st_mode):
                raise Failure("unsafe_path")
            if value.st_size != self.expected_size:
                raise Failure("size_mismatch")
            self.source_signature = signature(value)
            self.source_fd = read_fd(self.source_path_fd)
            size, digest = hash_open_fd(self.source_fd)
            if size != self.expected_size:
                raise Failure("size_mismatch")
            if digest != self.expected_sha256:
                raise Failure("hash_mismatch")
            self.check_source()
            os.lseek(self.source_fd, 0, os.SEEK_SET)
            self.stream_hash = hashlib.sha256()
            return {"ok": True}
        finally:
            os.close(parent)

    def check_source(self):
        self.check_workspace()
        current = os.fstat(self.source_path_fd)
        if signature(current) != self.source_signature or signature(os.fstat(self.source_fd)) != self.source_signature:
            raise Failure("source_changed")
        parent = open_parent(self.workspace_fd, self.parent_parts)
        try:
            if inode(os.fstat(parent)) != self.parent_identity:
                raise Failure("source_changed")
            entry = os.stat(self.basename, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(entry.st_mode) or signature(entry) != self.source_signature:
                raise Failure("source_changed")
        finally:
            os.close(parent)

    def read_source(self, request):
        require_object(request, {"op", "offset"})
        if self.role != "source" or self.source_fd is None:
            raise Failure("io_failed")
        offset = require_size(request["offset"])
        if offset != self.offset or offset >= self.expected_size:
            raise Failure("size_mismatch")
        expected = min(CHUNK, self.expected_size - offset)
        try:
            data = os.read(self.source_fd, expected)
        except OSError:
            raise Failure("io_failed")
        if len(data) != expected:
            raise Failure("size_mismatch")
        self.offset += len(data)
        self.stream_hash.update(data)
        return {"ok": True, "data": base64.b64encode(data).decode("ascii")}

    def finish_source(self, request):
        require_object(request, {"op"})
        if self.role != "source" or self.offset != self.expected_size:
            raise Failure("size_mismatch")
        try:
            if os.read(self.source_fd, 1):
                raise Failure("size_mismatch")
        except OSError:
            raise Failure("io_failed")
        self.check_source()
        digest = self.stream_hash.hexdigest()
        if digest != self.expected_sha256:
            raise Failure("hash_mismatch")
        return {"ok": True, "size": self.expected_size, "sha256": digest, "sourceReadAt": utc_now()}

    def open_target(self, request):
        require_object(request, {"op", "agentId", "destinationBasename", "expectedSize", "expectedSha256"})
        if self.role is not None:
            raise Failure("io_failed")
        self.role = "target"
        self.expected_size = require_size(request["expectedSize"])
        self.expected_sha256 = require_digest(request["expectedSha256"])
        self.basename = require_text(request["destinationBasename"])
        if "/" in self.basename or self.basename in (".", ".."):
            raise Failure("unsafe_path")
        self.workspace(request["agentId"])
        try:
            final_fd = open_path(self.workspace_fd, self.basename)
        except Failure:
            final_fd = None
        if final_fd is not None:
            try:
                value = os.fstat(final_fd)
                if not stat.S_ISREG(value.st_mode):
                    raise Failure("destination_conflict")
                fd = read_fd(final_fd)
                try:
                    size, digest = hash_open_fd(fd)
                finally:
                    os.close(fd)
                if size != self.expected_size or digest != self.expected_sha256:
                    raise Failure("destination_conflict")
                self.verified_at = utc_now()
                return {"ok": True, "existing": "matching"}
            finally:
                os.close(final_fd)
        try:
            self.temp_fd = os.open(".", os.O_TMPFILE | os.O_RDWR, 0o600, dir_fd=self.workspace_fd)
            os.fchown(self.temp_fd, *self.workspace_owner)
            os.fchmod(self.temp_fd, 0o600)
        except OSError:
            raise Failure("unsupported_node")
        self.stream_hash = hashlib.sha256()
        return {"ok": True, "existing": "absent"}

    def write_target(self, request):
        require_object(request, {"op", "offset", "data"})
        if self.role != "target" or self.temp_fd is None or self.verified_at is not None or self.published:
            raise Failure("io_failed")
        offset = require_size(request["offset"])
        if offset != self.offset or offset >= self.expected_size:
            raise Failure("size_mismatch")
        encoded = request["data"]
        if not isinstance(encoded, str) or len(encoded) > 43692:
            raise Failure("size_mismatch")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise Failure("size_mismatch")
        if base64.b64encode(data).decode("ascii") != encoded:
            raise Failure("size_mismatch")
        expected = min(CHUNK, self.expected_size - offset)
        if len(data) != expected:
            raise Failure("size_mismatch")
        write_all(self.temp_fd, data)
        self.offset += len(data)
        self.stream_hash.update(data)
        return {"ok": True, "nextOffset": self.offset}

    def verify_target(self, request):
        require_object(request, {"op"})
        if self.role != "target" or self.temp_fd is None or self.offset != self.expected_size:
            raise Failure("size_mismatch")
        try:
            os.fsync(self.temp_fd)
        except OSError:
            raise Failure("io_failed")
        size, digest = hash_open_fd(self.temp_fd)
        if size != self.expected_size:
            raise Failure("size_mismatch")
        if digest != self.expected_sha256 or self.stream_hash.hexdigest() != digest:
            raise Failure("hash_mismatch")
        self.verified_at = utc_now()
        return {"ok": True, "size": size, "sha256": digest, "targetVerifiedAt": self.verified_at}

    def matching_final(self):
        final_path_fd = open_path(self.workspace_fd, self.basename)
        try:
            value = os.fstat(final_path_fd)
            if not stat.S_ISREG(value.st_mode):
                raise Failure("destination_conflict")
            final_fd = read_fd(final_path_fd)
            try:
                size, digest = hash_open_fd(final_fd)
                if inode(os.fstat(final_fd)) != inode(value):
                    raise Failure("destination_conflict")
            finally:
                os.close(final_fd)
            if size != self.expected_size or digest != self.expected_sha256:
                raise Failure("destination_conflict")
            return inode(value)
        finally:
            os.close(final_path_fd)

    def actual_path(self):
        try:
            root = os.readlink(f"/proc/self/fd/{ROOT_FD}")
        except OSError:
            raise Failure("io_failed")
        return str(Path(root) / self.agent_id / self.basename)

    def stored(self, mode, target_verified_at):
        self.check_workspace()
        return {
            "ok": True,
            "mode": mode,
            "size": self.expected_size,
            "sha256": self.expected_sha256,
            "actualPath": self.actual_path(),
            "targetVerifiedAt": target_verified_at,
            "storedAt": utc_now(),
        }

    def commit_target(self, request):
        require_object(request, {"op"})
        if self.role != "target":
            raise Failure("io_failed")
        self.check_workspace()
        if self.temp_fd is None:
            self.matching_final()
            return self.stored("already_present", self.verified_at)
        if self.verified_at is None:
            raise Failure("io_failed")
        mode = "copied"
        try:
            os.link(f"/proc/self/fd/{self.temp_fd}", self.basename, dst_dir_fd=self.workspace_fd, follow_symlinks=True)
            self.published = True
        except FileExistsError:
            self.matching_final()
            mode = "already_present"
        except OSError:
            raise Failure("io_failed")
        try:
            os.fsync(self.workspace_fd)
        except OSError:
            raise Failure("io_failed")
        self.check_workspace()
        final_inode = self.matching_final()
        if mode == "copied" and final_inode != inode(os.fstat(self.temp_fd)):
            raise Failure("destination_conflict")
        return self.stored(mode, self.verified_at)

    def call(self, request):
        if not isinstance(request, dict) or not isinstance(request.get("op"), str):
            raise Failure("io_failed")
        operations = {
            "open_source": self.open_source,
            "read": self.read_source,
            "source_finish": self.finish_source,
            "open_target": self.open_target,
            "write": self.write_target,
            "verify_target": self.verify_target,
            "commit_target": self.commit_target,
        }
        operation = operations.get(request["op"])
        if operation is None:
            raise Failure("io_failed")
        return operation(request)


def emit(value):
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME:
        payload = b'{"ok":false,"reason":"io_failed"}'
    sys.stdout.buffer.write(payload + b"\n")
    sys.stdout.buffer.flush()


def main():
    helper = Helper()
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not line:
            return
        if len(line) > MAX_FRAME or not line.endswith(b"\n"):
            emit({"ok": False, "reason": "io_failed"})
            return
        try:
            request = json.loads(line)
            response = helper.call(request)
        except Failure as error:
            response = {"ok": False, "reason": error.reason}
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
            response = {"ok": False, "reason": "io_failed"}
        except OSError:
            response = {"ok": False, "reason": "io_failed"}
        emit(response)


if __name__ == "__main__":
    main()
