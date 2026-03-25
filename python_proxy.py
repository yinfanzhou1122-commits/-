import os
import ssl
import json
import time
import traceback
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Completely disable all TLS warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)
CORS(app)

API_BASE_URL = os.environ.get('API_BASE_URL', 'https://ai.t8star.cn')

# Create a robust session with a TIMEOUT to avoid infinite hanging
session = requests.Session()
retry = Retry(connect=3, backoff_factor=0.5)
adapter = HTTPAdapter(max_retries=retry)
session.mount('https://', adapter)
session.verify = False

# 超时设置：connect 10s, read 120s (有些模型响应较慢)
REQUEST_TIMEOUT = (10, 120)

print(f"🚀 Python Proxy Starting...")
print(f"📡 API Base URL: {API_BASE_URL}")

@app.route('/api/parse-prompt', methods=['POST'])
def parse_prompt():
    data = request.json
    prompt = data.get('prompt', '')
    api_key = data.get('apiKey', '')
    
    print(f"\n{'='*60}")
    print(f"📥 [parse-prompt] 收到请求")
    print(f"   提示词长度: {len(prompt)} 字符")
    print(f"   API Key: {api_key[:8]}...{api_key[-4:] if len(api_key) > 12 else '***'}")
    print(f"   目标URL: {API_BASE_URL}/v1/chat/completions")
    print(f"   模型: gemini-3.1-pro-preview")
    
    gemini_prompt = f"""你是一个角色信息批量提取器。以下文本包含 **多个角色的描述**，每个角色用换行分隔，一行一个角色。

请逐个解析每一行/每一段角色描述，提取以下信息：
1. name（角色名）：每段开头、括号前的中文名字。例如"姜雨眠（226次/01）"中提取"姜雨眠"。括号及其内容忽略。
2. gender（性别）：如"女性"、"男性"。
3. age（年龄）：如"二十岁出头"、"三岁半"、"二十八岁左右"。
4. era（时代背景）：从服装、画风推断，如"民国"、"现代"、"古代"。
5. hair_description（发型描述）：发型关键词，如"黑色中长卷发，半扎半披，珍珠发卡"。
6. clothing_description（服装描述）：服装关键词，如"米白色波点衬衫，深红色收腰呢子外套"。
7. profession（身份）：如"资本小姐"、"军官"、"幼儿"。

请严格返回以下JSON格式（注意是包含 characters 数组的对象），不要包含任何markdown代码块或其他文字：
{{"characters": [
  {{"name": "角色名1", "gender": "性别", "age": "年龄", "era": "时代背景", "hair_description": "发型", "clothing_description": "服装", "profession": "身份"}},
  {{"name": "角色名2", "gender": "性别", "age": "年龄", "era": "时代背景", "hair_description": "发型", "clothing_description": "服装", "profession": "身份"}}
]}}

有多少段角色描述，就返回多少个对象。

角色描述文本：
{prompt}"""
    
    request_body = {
        "model": "gemini-3.1-pro-preview",
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": "你是一个专业的角色信息提取助手，只输出JSON格式的结果。返回的JSON必须包含一个characters数组。" },
            { "role": "user", "content": gemini_prompt }
        ]
    }
    
    try:
        print(f"⏳ [parse-prompt] 发送请求到 API...")
        start_time = time.time()
        
        resp = session.post(f"{API_BASE_URL}/v1/chat/completions", 
            json=request_body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            timeout=REQUEST_TIMEOUT
        )
        
        elapsed = time.time() - start_time
        print(f"✅ [parse-prompt] API 响应! 耗时: {elapsed:.2f}s")
        print(f"   HTTP 状态码: {resp.status_code}")
        print(f"   响应头: {dict(resp.headers)}")
        
        resp_text = resp.text
        print(f"   响应内容 (前500字): {resp_text[:500]}")
        
        if resp.status_code != 200:
            print(f"❌ [parse-prompt] API 返回错误状态码: {resp.status_code}")
            return jsonify({
                "success": False, 
                "message": f"API Error (HTTP {resp.status_code}): {resp_text[:300]}",
                "debug": {
                    "status_code": resp.status_code,
                    "elapsed": elapsed,
                    "response_preview": resp_text[:500]
                }
            }), 500
            
        json_data = resp.json()
        print(f"   JSON 解析成功")
        
        # 检查返回结构
        if 'choices' not in json_data:
            print(f"⚠️ [parse-prompt] 响应中没有 'choices' 字段!")
            print(f"   完整响应: {json.dumps(json_data, ensure_ascii=False, indent=2)[:1000]}")
            return jsonify({
                "success": False,
                "message": "API 响应格式异常：没有 choices 字段",
                "debug": {"raw_response": json_data}
            }), 500
        
        content = json_data['choices'][0]['message']['content']
        print(f"   AI 返回内容: {content[:500]}")
        
        parsed = json.loads(content)
        
        # 确保返回的是 characters 数组格式
        if 'characters' in parsed:
            characters = parsed['characters']
        elif isinstance(parsed, list):
            characters = parsed
        else:
            # 兼容单角色返回
            characters = [parsed]
        
        print(f"🎯 [parse-prompt] 解析成功! 共 {len(characters)} 个角色")
        for i, char in enumerate(characters):
            print(f"   角色{i+1}: {char.get('name', '?')} | {char.get('gender', '?')} | {char.get('age', '?')}")
        
        return jsonify({
            "success": True, 
            "characters": characters
        })
    except requests.exceptions.ConnectTimeout:
        print(f"❌ [parse-prompt] 连接超时! 无法连接到 {API_BASE_URL}")
        return jsonify({"success": False, "message": f"连接超时：无法连接到 {API_BASE_URL}，请检查网络/代理设置"}), 500
    except requests.exceptions.ReadTimeout:
        print(f"❌ [parse-prompt] 读取超时! API 响应时间过长")
        return jsonify({"success": False, "message": "读取超时：API 响应时间过长（>120秒）"}), 500
    except requests.exceptions.ConnectionError as e:
        print(f"❌ [parse-prompt] 连接错误: {e}")
        return jsonify({"success": False, "message": f"连接错误: {str(e)[:200]}"}), 500
    except json.JSONDecodeError as e:
        print(f"❌ [parse-prompt] JSON 解析失败: {e}")
        print(f"   原始内容: {content[:500] if 'content' in dir() else 'N/A'}")
        return jsonify({"success": False, "message": f"AI 返回内容不是合法 JSON: {str(e)}"}), 500
    except Exception as e:
        print(f"❌ [parse-prompt] 未知错误: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/generate-image', methods=['POST'])
def generate_image():
    data = request.json
    api_key = data.get('apiKey')
    face = data.get('face')
    hair = data.get('hair')
    clothes = data.get('clothes')
    
    image_refs = [img for img in [face, hair, clothes] if img]
    prompt = "将图中的发型、人物脸部、服装，融合成一个新的人物，保持人物画风不变，纯白色背景，全身照，正对镜头，双手自然下垂。"
    
    print(f"\n{'='*60}")
    print(f"📥 [generate-image] 收到请求")
    print(f"   图片引用数量: {len(image_refs)}")
    print(f"   目标URL: {API_BASE_URL}/v1/images/generations")
    print(f"   模型: nano-banana-2")
    
    try:
        print(f"⏳ [generate-image] 发送请求到 API...")
        start_time = time.time()
        
        resp = session.post(f"{API_BASE_URL}/v1/images/generations",
            json={
                "model": "nano-banana-2",
                "prompt": prompt,
                "response_format": "url",
                "aspect_ratio": "3:4",
                "image": image_refs,
                "image_size": "2K"
            },
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            timeout=REQUEST_TIMEOUT
        )
        
        elapsed = time.time() - start_time
        print(f"✅ [generate-image] API 响应! 耗时: {elapsed:.2f}s")
        print(f"   HTTP 状态码: {resp.status_code}")
        print(f"   响应内容 (前500字): {resp.text[:500]}")
        
        if resp.status_code != 200:
            return jsonify({
                "success": False, 
                "message": f"API Error (HTTP {resp.status_code}): {resp.text[:300]}",
                "debug": {"status_code": resp.status_code, "elapsed": elapsed}
            }), 500
            
        json_data = resp.json()
        output_image = json_data.get('data', [{}])[0].get('url') or json_data.get('url')
        
        print(f"🎯 [generate-image] 生成成功!")
        print(f"   图片URL: {output_image[:100] if output_image else 'NONE'}")
        
        return jsonify({
            "success": True, 
            "imageUrl": output_image,
            "debug": {"elapsed": elapsed}
        })
    except requests.exceptions.ConnectTimeout:
        print(f"❌ [generate-image] 连接超时!")
        return jsonify({"success": False, "message": f"连接超时：无法连接到 {API_BASE_URL}"}), 500
    except requests.exceptions.ReadTimeout:
        print(f"❌ [generate-image] 读取超时!")
        return jsonify({"success": False, "message": "读取超时：API 响应时间过长（>120秒）"}), 500
    except Exception as e:
        print(f"❌ [generate-image] 未知错误: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

# 健康检查端点
@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "api_base_url": API_BASE_URL,
        "timestamp": time.time()
    })

if __name__ == '__main__':
    print(f"🌐 Python Proxy 监听端口: 5005")
    app.run(port=5005)
