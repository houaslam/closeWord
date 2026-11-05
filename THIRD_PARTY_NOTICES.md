# Word-vector data

The bundled `data/words.json` and `data/vectors.bin` derive from the pretrained `glove-wiki-gigaword-50` model distributed by Gensim-data:

- Model catalog and dataset-specific license link: https://github.com/piskvorky/gensim-data#models
- Source release: https://github.com/piskvorky/gensim-data/releases/tag/glove-wiki-gigaword-50
- Stanford GloVe project: https://nlp.stanford.edu/projects/glove/
- The model catalog identifies its dataset license as the Open Data Commons Public Domain Dedication and License: https://opendatacommons.org/licenses/pddl/

This application uses the first 50,000 alphabetic entries of length at least two, normalizes their 50-dimensional vectors, and computes its own rankings. The secret-word pool was assembled separately for this implementation. It does not contain the original CloseWord's private model or puzzle schedule.

The Gensim-data repository's code license is separate from the model-specific license. No Gensim runtime code is bundled or required by this application.
