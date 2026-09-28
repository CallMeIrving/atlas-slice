"""权重清单与下载。

刻意不在 ``__init__`` 里再导出 ``registry`` / ``download``：``download`` 会 import
``huggingface_hub``，而 ``app.main`` 的导入路径上只要 ``registry``。保持空壳能让
``uvicorn app.main:app`` 的启动不被 hf_hub 拖慢。
"""