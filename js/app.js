'use strict';


// Declare app level module which depends on filters, and services
angular.module('portfolio', ['portfolio.services', 'portfolio.filters']).
  config(['$routeProvider', function($routeProvider) {
    $routeProvider.when('/', {templateUrl: 'partials/featured.html', controller: WorkCtrl});
    $routeProvider.when('/more', {templateUrl: 'partials/more.html', controller: WorkCtrl});
    $routeProvider.otherwise({redirectTo: '/'});
  }]);
