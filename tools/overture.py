"""Overture Maps(GeoParquet, AWS S3 공개 버킷)에서 필요한 영역만 골라 읽기.

파일 전체(수백 GB)를 받지 않고, 각 parquet 파일의 row group 통계(bbox)를 보고
경로 주변에 걸치는 row group만 HTTP Range 요청으로 읽는다.
"""
import concurrent.futures as cf
import json
import os
import re

import pyarrow as pa
import pyarrow.parquet as pq
import requests
from shapely.geometry import box

from httpfile import HTTPRangeFile

BUCKET = 'https://overturemaps-us-west-2.s3.amazonaws.com/'
RELEASE = os.environ.get('OVERTURE_RELEASE', '2026-09-23.1')
CACHE = os.path.join(os.path.dirname(__file__), '.cache')
os.makedirs(CACHE, exist_ok=True)


def list_files(theme, typ):
    keys, token = [], None
    while True:
        url = f'{BUCKET}?list-type=2&prefix=release/{RELEASE}/theme={theme}/type={typ}/'
        if token:
            url += '&continuation-token=' + requests.utils.quote(token)
        s = requests.get(url, timeout=60).text
        keys += re.findall(r'<Key>(.*?)</Key>', s)
        m = re.search(r'<NextContinuationToken>(.*?)</NextContinuationToken>', s)
        if not m:
            return [k for k in keys if k.endswith('.parquet')]
        token = m.group(1)


def _rg_index(key):
    """row group별 bbox 목록 (캐시)"""
    path = os.path.join(CACHE, 'rg_' + re.sub(r'[^A-Za-z0-9]', '_', key)[-120:] + '.json')
    if os.path.exists(path):
        return json.load(open(path))
    f = pq.ParquetFile(HTTPRangeFile(BUCKET + key))
    md = f.metadata
    names = [md.row_group(0).column(i).path_in_schema for i in range(md.row_group(0).num_columns)]
    ix = {n: names.index(n) for n in ['bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax']}
    out = []
    for r in range(md.num_row_groups):
        rg = md.row_group(r)
        st = {k: rg.column(i).statistics for k, i in ix.items()}
        out.append([r, rg.num_rows, st['bbox.xmin'].min, st['bbox.xmax'].max, st['bbox.ymin'].min, st['bbox.ymax'].max])
    json.dump(out, open(path, 'w'))
    return out


def fetch(theme, typ, area, columns, row_filter=None, name=None, workers=12):
    """area(shapely 도형)에 걸치는 행만 모아 pyarrow Table로 돌려줌.
    row_filter(table) -> bool mask 배열 (선택)"""
    out_path = os.path.join(CACHE, f'{name or theme + "_" + typ}.parquet')
    if name and os.path.exists(out_path):
        return pq.read_table(out_path)
    keys = list_files(theme, typ)
    with cf.ThreadPoolExecutor(16) as ex:
        idx = dict(zip(keys, ex.map(_rg_index, keys)))
    jobs = []
    for key, rgs in idx.items():
        for r, n, x0, x1, y0, y1 in rgs:
            if area.intersects(box(x0, y0, x1, y1)):
                jobs.append((key, r))
    print(f'  {theme}/{typ}: row groups {len(jobs)}', flush=True)

    def work(job):
        key, r = job
        f = pq.ParquetFile(HTTPRangeFile(BUCKET + key))
        t = f.read_row_group(r, columns=columns)
        if row_filter is not None:
            m = row_filter(t)
            t = t.filter(m)
        return t

    tabs = []
    with cf.ThreadPoolExecutor(workers) as ex:
        for i, t in enumerate(ex.map(work, jobs)):
            if t.num_rows:
                tabs.append(t)
            if i % 20 == 0:
                print(f'    {i}/{len(jobs)}', flush=True)
    T = pa.concat_tables(tabs) if tabs else pa.table({c: [] for c in columns})
    if name:
        pq.write_table(T, out_path)
    return T
