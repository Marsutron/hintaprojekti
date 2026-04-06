python3 -m venv tuntipaska
source tuntipaska/bin/activate

pip install -r requirements.txt

# crontab -e
# 0 0 * * * /home/username/sahkohinta/venv/bin/python /home/username/sahkohinta/hinta.py
# */5 * * * * ./venv/bin/python ./tuntihinta.py

# ./venv/bin/python ./tuntihinta.py

# ./tuntipaska/bin/python ./app.py
