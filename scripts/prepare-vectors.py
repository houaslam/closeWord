"""Build the first 50,000 alphabetic GloVe vectors and an integrity manifest."""
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile

out = Path(__file__).resolve().parent.parent / 'data'
out.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='vectors-', dir=out) as temporary:
    stage = Path(temporary)
    words = []
    with gzip.open(sys.argv[1], 'rt', encoding='utf-8') as source, (stage / 'vectors.bin').open('wb') as binary:
        for line in source:
            cells = line.split()
            if len(cells) != 51 or not cells[0].isascii() or not cells[0].isalpha() or len(cells[0]) < 2:
                continue
            values = list(map(float, cells[1:]))
            norm = math.sqrt(sum(v * v for v in values))
            if not norm or not math.isfinite(norm):
                continue
            words.append(cells[0])
            binary.write(struct.pack('<50f', *(v / norm for v in values)))
            if len(words) == 50000:
                break
    if len(words) != 50000:
        raise RuntimeError('The source archive did not provide 50,000 complete vectors.')
    (stage / 'words.json').write_text(json.dumps(words))
    manifest = {
        'model': 'glove-wiki-gigaword-50',
        'source': 'https://github.com/piskvorky/gensim-data/releases/download/glove-wiki-gigaword-50/glove-wiki-gigaword-50.gz',
        'dimensions': 50,
        'vocabulary': len(words),
        'files': {name: hashlib.sha256((stage / name).read_bytes()).hexdigest() for name in ['words.json', 'vectors.bin']},
    }
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for name in ['words.json', 'vectors.bin', 'manifest.json']:
        os.replace(stage / name, out / name)
print('Prepared and checksummed 50,000 normalized word vectors.')
