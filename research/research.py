import os
import sys

from dotenv import load_dotenv
from google import genai


company_name = ' '.join(sys.argv[1:]).strip()

if not company_name:
    print('Error: Please provide a company name.')
    sys.exit(1)

project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dotenv_path = os.path.join(project_root, '.env')
load_dotenv(dotenv_path=dotenv_path)

api_key = os.getenv('GEMINI_API_KEY')

if not api_key:
    print('Error: GEMINI_API_KEY was not found in the root .env file.')
    sys.exit(1)

client = genai.Client(api_key=api_key)
prompt = (
    f'We are researching the company {company_name}. '
    'Confirm that you received the company name.'
)

response = client.interactions.create(
    model='gemini-flash-latest',
    input=prompt,
)

print(response.output_text)
