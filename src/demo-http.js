// To run this script, do:
//
// npm install express
// node demo.js

const express = require('express')
const app = express()

const bodyParser = require('body-parser')


// HTTP endpoint
app.use(bodyParser.json())



app.all('/number_plate_customer_lookup/v1/customer', (req, res) => {
  try {
    console.log(JSON.stringify(req.body, null, 2))
    console.log(JSON.stringify(req.query, null, 2))
  } catch (err) {}
  const plate = req?.query?.plate
  let customerDetails = {
      userDetails:{
        customerNumber: '1212456645',
			firstName: 'May',
			lastName: 'Brown',
			email: 'mbrown@madeup.com'
      }
    }
  if(plate === 'HF17WERT'){
    customerDetails = {
      userDetails:{
        customerNumber: '1212456643',
			firstName: 'John',
			lastName: 'Reeve',
			email: 'jreeve@madeup.com'
      }
    }
  }  
  if(plate === 'HF18WERT'){
    customerDetails = {
      userDetails:{
        customerNumber: '1212456644',
			firstName: 'Dave',
			lastName: 'Smith',
			email: 'dsmith@madeup.com'
      }
    }
  }

  res.send(customerDetails)
})

const httpPort = 3000
app.listen(httpPort, () => {
  console.log(`Example app listening at http://localhost:${httpPort}`)
})


