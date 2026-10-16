"""HTTP Range 요청으로 원격 파일을 읽는 파일 객체 (pyarrow.parquet용)."""
import io
import requests

_session = requests.Session()


class HTTPRangeFile(io.RawIOBase):
    def __init__(self, url, block=1 << 20):
        self.url = url
        self.pos = 0
        self.block = block
        self.cache = {}
        r = _session.head(url, timeout=60)
        r.raise_for_status()
        self.size = int(r.headers['Content-Length'])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        if whence == 0:
            self.pos = off
        elif whence == 1:
            self.pos += off
        else:
            self.pos = self.size + off
        return self.pos

    def _get(self, start, end):
        for _ in range(5):
            try:
                r = _session.get(self.url, headers={'Range': f'bytes={start}-{end - 1}'}, timeout=120)
                r.raise_for_status()
                return r.content
            except requests.RequestException:
                continue
        raise IOError('range read failed')

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b''
        data = self._get(self.pos, self.pos + n)
        self.pos += len(data)
        return data

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)
