"""图层拆分算法管线。

阶段：detect → ocr → segment → refine → zorder → background → export

重依赖（torch / transformers / cv2）都推迟到真正用到时才导入，保证 API 启动足够快。
"""