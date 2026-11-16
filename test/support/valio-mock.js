import { pool } from '../../src/db.js';
export class TestValioClient {
  constructor() { this.mock = true; }
  price(request) { return this.call('price', request); }
  availability(request) { return this.call('availability', request); }
  async call(endpoint, request) {
    if (endpoint === 'price') return {customerId:request.customer,currency:'EUR',pricingDate:request.requestedDate,
      products:request.products.map(productId => ({productId,quantity:1,netPriceFound:false,error:false,
        priceWithTax:{value:2.5,currency:'EUR',validFrom:request.requestedDate,validTo:request.requestedDate}}))};
    const inventory = (await pool.query('SELECT product_id,quantity FROM inventory WHERE product_id=ANY($1)',[request.products])).rows;
    return {timeNow:new Date().toISOString(),requestedDate:request.requestedDate,products:request.products.map(productId => ({
      productId,salesBlock:false,logisticModel:'Stock',closingTime:null,scheduleLines:[{availableAmount:Number(inventory.find(p=>p.product_id===productId)?.quantity??0),availableDate:request.requestedDate,salesUnit:'MOCK',salesBlock:false}]
    }))};
  }
}
